/*
 * RHLab simulation: users, groups, passwords, sudo. Plain browser JS, one IIFE.
 * Commands: id groups getent useradd usermod userdel groupadd groupdel gpasswd passwd
 *           chage su sudo visudo sed (sed: only the s/RE/REP/[g] and /RE/d forms).
 * State lives in host.users / host.groups and in files; this module only reads and changes those.
 */
(function () {
  'use strict';
  const Sim = window.Sim;
  const reg = Sim.register;

  // ---------------------------------------------------------------- helpers
  const DAY_MS = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayNum = () => Math.floor(Date.now() / DAY_MS);
  const isoDay = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
  const prettyDay = n => {
    const d = new Date(n * DAY_MS);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  };

  function checkDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) {
      throw new Error("invalid date '" + s + "'");
    }
    return s;
  }
  const dayOf = s => Math.floor(Date.parse(checkDate(s) + 'T00:00:00Z') / DAY_MS);

  function intArg(v) {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isInteger(n)) throw new Error("invalid numeric argument '" + v + "'");
    return n;
  }

  function requireRoot(ctx) {
    if (ctx.session.user !== 'root') throw new Error('Permission denied');
  }

  // /etc/login.defs values, read fresh on every call (a later sed on the file affects only new users).
  function loginDefs(host) {
    const d = {};
    for (const l of Sim.fileLines(host, '/etc/login.defs')) { const f = l.split(/\s+/); d[f[0]] = f[1]; }
    const num = (k, dflt) => (d[k] !== undefined && !isNaN(Number(d[k])) ? Number(d[k]) : dflt);
    return {
      PASS_MAX_DAYS: num('PASS_MAX_DAYS', 99999),
      PASS_MIN_DAYS: num('PASS_MIN_DAYS', 0),
      PASS_WARN_AGE: num('PASS_WARN_AGE', 7),
      UID_MIN: num('UID_MIN', 1000),
      GID_MIN: num('GID_MIN', 1000),
    };
  }

  const usedUids = host => Object.values(host.users).map(u => u.uid);
  const usedGids = host => Object.values(host.groups).map(g => g.gid);
  const nextFree = (used, min) => { let n = min; while (used.indexOf(n) !== -1) n++; return n; };
  const groupNameOf = (host, gid) => Object.keys(host.groups).find(g => host.groups[g].gid === gid);

  function needUser(host, name) {
    const u = host.users[name];
    if (!u) throw new Error("user '" + name + "' does not exist");
    return u;
  }
  function needGroup(host, name) {
    const g = host.groups[name];
    if (!g) throw new Error("group '" + name + "' does not exist");
    return g;
  }
  // Primary group first, then the other memberships.
  function groupList(host, name) {
    const prim = groupNameOf(host, host.users[name].gid);
    return [prim].concat(Sim.userGroups(host, name).filter(g => g !== prim)).filter(Boolean);
  }
  const validShell = (host, shell) => Sim.fileLines(host, '/etc/shells').indexOf(shell) !== -1;

  // getopt-style parser. valueChars take an argument (rest of the token, or the next token);
  // flagChars are booleans; "--name" is stored as o.name. Everything else is positional.
  function opts(args, valueChars, flagChars) {
    const o = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { rest.push(...args.slice(i + 1)); break; }
      if (a.length > 2 && a.slice(0, 2) === '--') { o[a.slice(2)] = true; continue; }
      if (a.length < 2 || a[0] !== '-') { rest.push(a); continue; }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (valueChars.indexOf(c) !== -1) {
          o[c] = j + 1 < a.length ? a.slice(j + 1) : args[++i];
          if (o[c] === undefined) throw new Error("option requires an argument -- '" + c + "'");
          break;
        }
        if (flagChars.indexOf(c) === -1) throw new Error("invalid option -- '" + c + "'");
        o[c] = true;
      }
    }
    return { o: o, rest: rest };
  }

  // ---------------------------------------------------------------- sudoers helpers
  const RULE_RE = /^(%?[A-Za-z_][A-Za-z0-9_-]*)\s+ALL=\(([^)]*)\)\s+(NOPASSWD:|PASSWD:)?\s*(.+)$/;
  const SUDO_LINE_RE = /^(%?[A-Za-z_][A-Za-z0-9_-]*)\s+ALL=\(.*\)\s+(NOPASSWD:\s*|PASSWD:\s*)?.+$/;

  // /etc/sudoers plus every regular file in /etc/sudoers.d/.
  function sudoFiles(host) {
    const files = ['/etc/sudoers'];
    if (Sim.fs.isDir(host, '/etc/sudoers.d')) {
      for (const f of Sim.fs.list(host, '/etc/sudoers.d')) {
        const p = '/etc/sudoers.d/' + f;
        if (Sim.fs.isFile(host, p)) files.push(p);
      }
    }
    return files;
  }

  function sudoRules(host) {
    const rules = [];
    for (const f of sudoFiles(host)) {
      for (const line of Sim.fileLines(host, f)) {
        if (/^Defaults/.test(line)) continue;
        const m = line.match(RULE_RE);
        if (m) rules.push({ who: m[1], runas: m[2], nopasswd: m[3] === 'NOPASSWD:', cmds: m[4].split(',').map(s => s.trim()) });
      }
    }
    return rules;
  }

  function ruleMatches(host, r, user, target, argv0) {
    const base = s => s.split(' ')[0].split('/').pop();
    const whoOk = r.who === user || r.who === 'ALL' ||
      (r.who[0] === '%' && Sim.userGroups(host, user).indexOf(r.who.slice(1)) !== -1);
    const runasOk = r.runas.split(',').some(x => x === target || x.split(':')[0] === 'ALL');
    const cmdOk = r.cmds.some(c => c === 'ALL' || base(c) === base(argv0));
    return whoOk && runasOk && cmdOk;
  }

  // Re-quote argv so Sim.exec's tokenizer sees the same words again.
  const quoteArg = a => (/^[\w\/.=:,@%+-]+$/.test(a) ? a : '"' + a.replace(/(["\\$])/g, '\\$1') + '"');

  const SUDO_BAD_PERM = 'bad permissions, should be mode 0440';
  function checkSudoFile(host, f) {
    const node = Sim.fs.get(host, f);
    if (!node) return [f + ': No such file or directory'];
    const errs = [];
    if (f !== '/etc/sudoers' && [0o440, 0o400].indexOf(node.mode & 0o777) === -1) errs.push(f + ': ' + SUDO_BAD_PERM);
    (node.content || '').split('\n').forEach((raw, idx) => {
      const l = raw.trim();
      if (!l || l[0] === '#' || /^Defaults\b/.test(l) || SUDO_LINE_RE.test(l)) return;
      errs.push(f + ': syntax error on line ' + (idx + 1) + ' near "' + l + '"');
    });
    return errs;
  }

  // ---------------------------------------------------------------- id / groups / getent
  reg('id', function (ctx) {
    const name = ctx.args[0] || ctx.session.user;
    const u = ctx.host.users[name];
    if (!u) throw new Error("'" + name + "': no such user");
    const pg = groupNameOf(ctx.host, u.gid);
    const list = groupList(ctx.host, name).map(g => ctx.host.groups[g].gid + '(' + g + ')');
    ctx.out('uid=' + u.uid + '(' + name + ') gid=' + u.gid + '(' + pg + ') groups=' + list.join(',') + '\n');
    return 0;
  });

  reg('groups', function (ctx) {
    const names = ctx.args.length ? ctx.args : [ctx.session.user];
    let code = 0;
    for (const n of names) {
      if (!ctx.host.users[n]) { ctx.err("groups: '" + n + "': no such user\n"); code = 1; continue; }
      ctx.out(n + ' : ' + groupList(ctx.host, n).join(' ') + '\n');
    }
    return code;
  });

  reg('getent', function (ctx) {
    const db = ctx.args[0];
    const key = ctx.args[1];
    const host = ctx.host;
    if (!db) throw new Error('usage: getent passwd|group [KEY]');
    let lines;
    if (db === 'passwd') {
      lines = Object.keys(host.users).filter(n => !key || n === key).map(n => {
        const u = host.users[n];
        return [n, 'x', u.uid, u.gid, u.comment || '', u.home, u.shell].join(':');
      });
    } else if (db === 'group') {
      lines = Object.keys(host.groups).filter(g => !key || g === key).map(g => {
        const rec = host.groups[g];
        return [g, 'x', rec.gid, rec.members.join(',')].join(':');
      });
    } else {
      throw new Error("unsupported database '" + db + "'");
    }
    if (!lines.length) return 2;
    lines.forEach(l => ctx.out(l + '\n'));
    return 0;
  });

  // ---------------------------------------------------------------- user management
  reg('useradd', function (ctx) {
    requireRoot(ctx);
    const { o, rest } = opts(ctx.args, 'ugGdsec', 'Mm');
    if (rest.length !== 1) throw new Error('usage: useradd [options] LOGIN');
    const host = ctx.host;
    const name = rest[0];
    if (host.users[name]) throw new Error("user '" + name + "' already exists");
    const defs = loginDefs(host);

    // Validate everything before changing anything.
    const uid = o.u !== undefined ? intArg(o.u) : nextFree(usedUids(host), defs.UID_MIN);
    if (usedUids(host).indexOf(uid) !== -1) throw new Error('UID ' + uid + ' is not unique');
    let gid;
    if (o.g !== undefined) {
      gid = needGroup(host, o.g).gid;
    } else {
      if (host.groups[name]) throw new Error("group '" + name + "' already exists");
      gid = usedGids(host).indexOf(uid) === -1 ? uid : nextFree(usedGids(host), defs.GID_MIN);
    }
    const extra = o.G ? o.G.split(',').filter(Boolean) : [];
    extra.forEach(g => needGroup(host, g));
    const shell = o.s || '/bin/bash';
    if (!validShell(host, shell)) throw new Error('invalid shell');
    if (o.e !== undefined) checkDate(o.e);
    const home = o.d || '/home/' + name;
    const makeHome = !o.M && !Sim.fs.exists(host, home);
    if (makeHome && !Sim.fs.isDir(host, Sim.fs.parent(home))) throw new Error("cannot create directory '" + home + "'");

    // Changes.
    if (o.g === undefined) host.groups[name] = { gid: gid, members: [] };
    for (const g of extra) {
      const m = host.groups[g].members;
      if (m.indexOf(name) === -1) m.push(name);
    }
    if (makeHome) {
      Sim.fs.create(host, home, { type: 'dir', mode: 0o700 });
      Sim.fs.chown(host, home, uid, gid);
    }
    host.users[name] = {
      uid: uid, gid: gid, home: home, shell: shell, pw: '', pwSetDay: 0,
      maxDays: defs.PASS_MAX_DAYS, minDays: defs.PASS_MIN_DAYS, warnDays: defs.PASS_WARN_AGE,
      expire: o.e || null, locked: true, mustChange: false, comment: o.c || '',
    };
    return 0;
  });

  reg('usermod', function (ctx) {
    requireRoot(ctx);
    const { o, rest } = opts(ctx.args, 'Gsdec', 'aLU');
    if (rest.length !== 1) throw new Error('usage: usermod [options] LOGIN');
    const host = ctx.host;
    const name = rest[0];
    const u = needUser(host, name);
    if (o.a && o.G === undefined) throw new Error('-a requires -G');
    const list = o.G !== undefined ? o.G.split(',').filter(Boolean) : null;
    if (list) list.forEach(g => needGroup(host, g));
    if (o.s !== undefined && !validShell(host, o.s)) throw new Error('invalid shell');
    if (o.e !== undefined && o.e !== '' && o.e !== '-1') checkDate(o.e);

    if (list) {
      for (const g of Object.keys(host.groups)) {
        const rec = host.groups[g];
        if (rec.gid === u.gid) continue; // the primary group is not a membership list
        const i = rec.members.indexOf(name);
        const want = list.indexOf(g) !== -1;
        if (want && i === -1) rec.members.push(name);
        if (!want && !o.a && i !== -1) rec.members.splice(i, 1);
      }
    }
    if (o.s !== undefined) u.shell = o.s;
    if (o.d !== undefined) u.home = o.d;
    if (o.e !== undefined) u.expire = (o.e === '' || o.e === '-1') ? null : o.e;
    if (o.c !== undefined) u.comment = o.c;
    if (o.L) u.locked = true;
    if (o.U) u.locked = false;
    return 0;
  });

  reg('userdel', function (ctx) {
    requireRoot(ctx);
    const { o, rest } = opts(ctx.args, '', 'r');
    if (rest.length !== 1) throw new Error('usage: userdel [-r] LOGIN');
    const host = ctx.host;
    const name = rest[0];
    if (name === 'root') throw new Error("user 'root' cannot be removed");
    const u = needUser(host, name);
    if (o.r && u.home !== '/' && Sim.fs.exists(host, u.home)) Sim.fs.remove(host, u.home, { recursive: true });
    for (const g of Object.values(host.groups)) g.members = g.members.filter(m => m !== name);
    // Like RHEL (USERGROUPS_ENAB): drop the private group unless someone else has it as primary.
    const pg = host.groups[name];
    const shared = Object.keys(host.users).some(n => n !== name && host.users[n].gid === u.gid);
    if (pg && pg.gid === u.gid && !shared) delete host.groups[name];
    delete host.users[name];
    return 0;
  });

  reg('groupadd', function (ctx) {
    requireRoot(ctx);
    const { o, rest } = opts(ctx.args, 'g', '');
    if (rest.length !== 1) throw new Error('usage: groupadd [-g GID] GROUP');
    const host = ctx.host;
    const name = rest[0];
    if (host.groups[name]) throw new Error("group '" + name + "' already exists");
    let gid;
    if (o.g !== undefined) {
      gid = intArg(o.g);
      if (usedGids(host).indexOf(gid) !== -1) throw new Error('GID ' + gid + ' already in use');
    } else {
      gid = nextFree(usedGids(host), loginDefs(host).GID_MIN);
    }
    host.groups[name] = { gid: gid, members: [] };
    return 0;
  });

  reg('groupdel', function (ctx) {
    requireRoot(ctx);
    if (ctx.args.length !== 1) throw new Error('usage: groupdel GROUP');
    const host = ctx.host;
    const name = ctx.args[0];
    const g = needGroup(host, name);
    const owner = Object.keys(host.users).find(n => host.users[n].gid === g.gid);
    if (owner) throw new Error("cannot remove the primary group of user '" + owner + "'");
    delete host.groups[name];
    return 0;
  });

  reg('gpasswd', function (ctx) {
    requireRoot(ctx);
    const { o, rest } = opts(ctx.args, '', 'ad');
    if (rest.length !== 2 || !(o.a || o.d) || (o.a && o.d)) throw new Error('usage: gpasswd -a USER GROUP | -d USER GROUP');
    const [name, group] = rest;
    needUser(ctx.host, name);
    const members = needGroup(ctx.host, group).members;
    const i = members.indexOf(name);
    if (o.a) {
      if (i === -1) members.push(name);
      ctx.out('Adding user ' + name + ' to group ' + group + '\n');
    } else {
      if (i === -1) throw new Error("user '" + name + "' is not a member of '" + group + "'");
      members.splice(i, 1);
      ctx.out('Removing user ' + name + ' from group ' + group + '\n');
    }
    return 0;
  });

  // ---------------------------------------------------------------- passwords and aging
  reg('passwd', function (ctx) {
    const { o, rest } = opts(ctx.args, '', 'luSe');
    if (rest.length > 1) throw new Error('usage: passwd [--stdin] [-l|-u|-e|-S] [USER]');
    const host = ctx.host;
    const self = ctx.session.user;
    const name = rest[0] || self;
    if (self !== 'root' && name !== self) throw new Error('You may not view or modify password information for ' + name + '.');
    const u = needUser(host, name);

    if (o.S) {
      const status = u.locked ? 'LK' : (u.pw ? 'PS' : 'NP');
      const desc = u.locked ? 'Password locked.' : (u.pw ? 'Password set, SHA512 crypt.' : 'No password set.');
      ctx.out(name + ' ' + status + ' ' + isoDay(u.pwSetDay) + ' ' + u.minDays + ' ' + u.maxDays + ' ' + u.warnDays + ' -1 (' + desc + ')\n');
      return 0;
    }
    if (o.l) {
      u.locked = true;
      ctx.out('Locking password for user ' + name + '.\npasswd: Success.\n');
      return 0;
    }
    if (o.u) {
      if (u.pw === '') throw new Error("unlocking the user's password would result in a passwordless account.");
      u.locked = false;
      ctx.out('Unlocking password for user ' + name + '.\npasswd: Success.\n');
      return 0;
    }
    if (o.e) {
      u.mustChange = true;
      ctx.out('Expiring password for user ' + name + '.\npasswd: Success.\n');
      return 0;
    }
    if (!o.stdin) {
      throw new Error('Interactive passwd is not supported in this simulator; use: echo PASSWORD | passwd --stdin USER');
    }
    const pw = (ctx.stdin || '').split('\n')[0];
    if (!pw) throw new Error('No password supplied');
    u.pw = pw;
    u.locked = false;
    u.mustChange = false;
    u.pwSetDay = todayNum();
    ctx.out('Changing password for user ' + name + '.\npasswd: all authentication tokens updated successfully.\n');
    return 0;
  });

  reg('chage', function (ctx) {
    requireRoot(ctx);
    const { o, rest } = opts(ctx.args, 'MmWEdI', 'l');
    if (rest.length !== 1) throw new Error('usage: chage [options] LOGIN');
    const u = needUser(ctx.host, rest[0]);
    if (o.M !== undefined) u.maxDays = intArg(o.M);
    if (o.m !== undefined) u.minDays = intArg(o.m);
    if (o.W !== undefined) u.warnDays = intArg(o.W);
    if (o.E !== undefined) u.expire = o.E === '-1' ? null : checkDate(o.E);
    if (o.d !== undefined) {
      if (o.d === '0') { u.pwSetDay = 0; u.mustChange = true; }
      else u.pwSetDay = dayOf(o.d);
    }
    if (o.l) {
      const last = u.mustChange ? 'password must be changed' : (u.pwSetDay === 0 ? 'never' : prettyDay(u.pwSetDay));
      const expires = u.mustChange ? 'password must be changed'
        : (u.pwSetDay === 0 || u.maxDays >= 99999 ? 'never' : prettyDay(u.pwSetDay + u.maxDays));
      const acct = u.expire ? prettyDay(dayOf(u.expire)) : 'never';
      const rows = [
        ['Last password change', last],
        ['Password expires', expires],
        ['Password inactive', 'never'],
        ['Account expires', acct],
        ['Minimum number of days between password change', u.minDays],
        ['Maximum number of days between password change', u.maxDays],
        ['Number of days of warning before password expires', u.warnDays],
      ];
      for (const [k, v] of rows) ctx.out(k.padEnd(52) + ': ' + v + '\n');
    }
    return 0;
  });

  // ---------------------------------------------------------------- su / sudo / visudo
  reg('su', function (ctx) {
    if (ctx.session.user !== 'root') throw new Error('Authentication failure');
    let target = 'root';
    let cmd;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-' || a === '-l' || a === '--login') continue;
      if (a === '-c') cmd = args[++i];
      else if (a[0] === '-') throw new Error("invalid option -- '" + a + "'");
      else target = a;
    }
    if (cmd === undefined) throw new Error('interactive shells are not supported in this simulator, use -c');
    const u = needUser(ctx.host, target);
    const r = Sim.exec(ctx.host.name, cmd, { user: target, cwd: u.home, env: {} });
    ctx.out(r.out);
    ctx.err(r.err);
    return r.code;
  });

  reg('sudo', function (ctx) {
    const args = ctx.args;
    let target = 'root';
    let noPrompt = false;
    let i = 0;
    for (; i < args.length && args[i][0] === '-'; i++) {
      if (args[i] === '--') { i++; break; }
      if (args[i] === '-u') {
        target = args[++i];
        if (target === undefined) throw new Error("option requires an argument -- 'u'");
      } else if (args[i] === '-n') {
        noPrompt = true;
      } else {
        throw new Error("invalid option -- '" + args[i] + "'");
      }
    }
    const cmd = args.slice(i);
    if (!cmd.length) throw new Error('usage: sudo [-u USER] [-n] COMMAND');
    const host = ctx.host;
    const me = ctx.session.user;
    const tu = host.users[target];
    if (!tu) throw new Error('unknown user: ' + target);
    if (me !== 'root') {
      const rules = sudoRules(host).filter(r => ruleMatches(host, r, me, target, cmd[0]));
      if (!rules.length) {
        ctx.err(me + ' is not in the sudoers file.  This incident will be reported.\n');
        return 1;
      }
      if (!rules.some(r => r.nopasswd)) {
        throw new Error(noPrompt ? 'a password is required' : 'a terminal is required to read the password');
      }
    }
    const r = Sim.exec(host.name, cmd.map(quoteArg).join(' '), { user: target, cwd: tu.home, env: {} });
    ctx.out(r.out);
    ctx.err(r.err);
    return r.code;
  });

  reg('visudo', function (ctx) {
    if (ctx.args.indexOf('-c') === -1) {
      throw new Error('interactive editing is not supported in this simulator; use visudo -c');
    }
    let bad = false;
    for (const f of sudoFiles(ctx.host)) {
      const errs = checkSudoFile(ctx.host, f);
      if (errs.length) {
        bad = true;
        errs.forEach(e => ctx.err(e + '\n'));
      } else {
        ctx.out(f + ': parsed OK\n');
      }
    }
    return bad ? 1 : 0;
  });

  // ---------------------------------------------------------------- sed (two forms only)
  reg('sed', function (ctx) {
    const inPlace = ctx.args.indexOf('-i') !== -1;
    const rest = ctx.args.filter(a => a !== '-i');
    const script = rest[0] || '';
    const file = rest[1];
    const sub = script.match(/^s\/((?:\\.|[^\/\\])*)\/((?:\\.|[^\/\\])*)\/(g?)$/);
    const del = script.match(/^\/((?:\\.|[^\/\\])*)\/d$/);
    if (!sub && !del) throw new Error('unsupported expression in this simulator');
    if (inPlace && !file) throw new Error('no input files');

    const unesc = s => s.replace(/\\\//g, '/');
    let transform;
    if (sub) {
      const re = new RegExp(unesc(sub[1]), sub[3] ? 'g' : '');
      const rep = unesc(sub[2]).replace(/\\(\d)/g, (_, d) => '$' + d);
      transform = text => text.split('\n').map(l => l.replace(re, rep)).join('\n');
    } else {
      const re = new RegExp(unesc(del[1]));
      transform = text => text.split('\n').filter(l => !re.test(l)).join('\n');
    }

    let text = ctx.stdin || '';
    let p = null;
    if (file) {
      p = Sim.fs.abs(ctx.host, ctx.session, file);
      const node = Sim.fs.get(ctx.host, p);
      if (!node) throw new Error("can't read " + file + ': No such file or directory');
      if (node.type === 'dir') throw new Error("can't read " + file + ': Is a directory');
      if (!Sim.fs.canAccess(ctx.host, ctx.session.user, p, 'r')) throw new Error("can't read " + file + ': Permission denied');
      if (inPlace && !Sim.fs.canAccess(ctx.host, ctx.session.user, p, 'w')) throw new Error("couldn't edit " + file + ': Permission denied');
      text = node.content || '';
    }
    const out = transform(text);
    if (inPlace) Sim.fs.write(ctx.host, p, out, { who: ctx.who() });
    else ctx.out(out);
    return 0;
  });
})();
