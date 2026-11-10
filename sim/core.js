/*
 * RHLab simulation core. Plain browser JS, no dependencies. Exposes window.Sim.
 *
 * ===== API for command modules (read this before writing a module) =====
 *
 *  Sim.register(name, fn)       fn(ctx) -> exit code (0 = success). Throw an Error to fail
 *                               (the shell prints "name: message" and exits 1).
 *  Sim.bootStep(phase, fn)      fn(host, lab) runs on every boot/reboot. Phases run in
 *                               order 1,2,3 across BOTH hosts (phase 1 for all hosts, then
 *                               phase 2 for all hosts...). Use phase 1 for starting services
 *                               and activating LVs, phase 2 for mounting fstab / swap,
 *                               phase 3 for things that depend on mounts (autofs).
 *  Sim.exec(hostName, line, session)  run a command line; returns {out, err, code}.
 *
 *  ctx (passed to every command):
 *    ctx.name      command name
 *    ctx.args      array of argument strings (quotes already removed)
 *    ctx.host      the host object the command runs on
 *    ctx.lab       the lab object ({hosts:{server,client}})
 *    ctx.session   {user, cwd}  -- cd mutates ctx.session.cwd
 *    ctx.stdin     string from a pipe or null
 *    ctx.out(s)    write to stdout (include your own "\n")
 *    ctx.err(s)    write to stderr
 *    ctx.cwd()     absolute current directory
 *    ctx.who()     {uid, gid, user} of the session user
 *
 *  Sim.fs  (all functions take a host object and ABSOLUTE paths, and THROW Error on failure
 *           with a message like "No such file or directory". Permission checks are NOT
 *           done automatically; call Sim.fs.assertAccess when a non-root user does it.)
 *    fs.abs(host, session, p)         absolute path from cwd / ~ (home) / relative
 *    fs.get(host, p)                  node or undefined: {type:'file'|'dir', mode, uid, gid, content?}
 *    fs.exists(host, p) / isDir / isFile
 *    fs.read(host, p)                 file content string
 *    fs.list(host, p)                 sorted child names
 *    fs.create(host, p, {type, mode, content, who, parents})   mkdir / new file (throws if exists)
 *    fs.write(host, p, content, {append, who})  create-or-replace a file (parent must exist)
 *    fs.remove(host, p, {recursive})
 *    fs.chmod(host, p, mode) / fs.chown(host, p, uid, gid)
 *    fs.canAccess(host, user, p, 'r'|'w'|'x')  boolean (root always true)
 *    fs.assertAccess(host, session, p, op)     throws "Permission denied"
 *    NOTE: paths under an NFS mount are transparently redirected to the server's export
 *          (fs.resolve does this), so reading /mnt/nfs/x reads server:/share/x.
 *
 *  Helpers
 *    Sim.parseFstab(host)    -> [{source, target, fstype, opts, dump, pass}] (ignores comments)
 *    Sim.parseExports(host)  -> [{path, clients:[{spec, opts}]}] from /etc/exports
 *    Sim.exportAllows(serverHost, remotePath, clientIp) -> boolean (checks that the server's
 *                            nfs-server is active and the export exists and allows the IP)
 *    Sim.findUser(host, name) -> user record or undefined (has uid, gid, home, shell, ...)
 *    Sim.userGroups(host, name) -> array of group names the user belongs to (incl. primary)
 *    Sim.fileLines(host, p)  -> array of non-empty, non-comment lines of a file ([] if missing)
 *    Sim.lab                 the current lab
 *    Sim.lab.host(nameOrIpOrHostname) -> host or undefined
 *
 *  Host object (PERSISTENT unless noted):
 *    name ('server'|'client'), hostname ('server.lab'), ip
 *    fs            {path: node}   whole filesystem tree, including /etc/* config files
 *    users         {name: {uid, gid, home, shell, pw, pwSetDay, maxDays, minDays, warnDays,
 *                          expire (YYYY-MM-DD|null), locked, mustChange}}
 *    groups        {name: {gid, members:[names]}}
 *    disks         {'/dev/loopN': {sizeMB, label:'disk1', pv:bool}}  (virtual; no real space)
 *    lvm           {pvs:{dev:{vg|null}}, vgs:{name:{peMB, pvs:[dev]}},
 *                   lvs:{'vg/lv':{vg, name, sizeMB, fs:null|'xfs'|'ext4'|'swap', uuid}}}
 *    units         {unitName: {enabled:bool}}     systemctl enable state
 *    active        RUNTIME, cleared on reboot: {mounts:[{source,target,fstype,opts}],
 *                   swaps:[dev], lvActive:{'vg/lv':true}, services:{name:{active:bool}},
 *                   bootErrors:[string]}
 *    hostname is also written to /etc/hostname by hostnamectl
 */
(function (global) {
  'use strict';

  const Sim = (global.Sim = global.Sim || {});
  Sim.commands = {};
  Sim.bootSteps = [];
  Sim.lab = null;
  Sim.accessHooks = [];   // fn(host, absPath) called on every path lookup (autofs)

  Sim.register = function (name, fn) { Sim.commands[name] = fn; };
  Sim.bootStep = function (phase, fn) { Sim.bootSteps.push({ phase: phase, fn: fn }); };

  class SimError extends Error {}
  Sim.SimError = SimError;
  const fail = (msg) => { throw new SimError(msg); };
  Sim.fail = fail;

  // ---------------------------------------------------------------- paths
  function normalize(p) {
    const parts = [];
    for (const seg of String(p).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  const fs = {};
  Sim.fs = fs;
  fs.norm = normalize;

  fs.abs = function (host, session, p) {
    const cwd = (session && session.cwd) || '/';
    let s = String(p);
    if (s === '~' || s.startsWith('~/')) {
      const u = session && session.user ? Sim.findUser(host, session.user) : null;
      const home = u ? u.home : '/root';
      s = home + s.slice(1);
    }
    if (s.startsWith('/')) return normalize(s);
    return normalize(cwd + '/' + s);
  };

  function parentOf(p) {
    if (p === '/') return null;
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  fs.parent = parentOf;

  // Walk mounts: a path under an NFS mount point is served from the server's export.
  fs.resolve = function (host, p) {
    // Access hooks run first (autofs uses this to mount on first access).
    // Hooks only fire for shell commands (Sim.shellActive), never for read-only checks.
    if (Sim.shellActive) {
      for (const hk of Sim.accessHooks) {
        try { hk(host, p); } catch (e) { /* a failing automount must not break the lookup */ }
      }
    }
    const mounts = (host.active && host.active.mounts) || [];
    let best = null;
    for (const m of mounts) {
      if (!m.fstype || !/^nfs/.test(m.fstype)) continue;
      if (p === m.target || p.startsWith(m.target === '/' ? '/' : m.target + '/')) {
        if (!best || m.target.length > best.target.length) best = m;
      }
    }
    if (!best) return { host: host, path: p };
    const idx = best.source.indexOf(':');
    const srvName = best.source.slice(0, idx);
    const rpath = best.source.slice(idx + 1);
    const srv = Sim.lab && Sim.lab.host(srvName);
    if (!srv) return { host: host, path: p };
    const rest = p.slice(best.target.length);
    return { host: srv, path: normalize(rpath + rest) };
  };

  fs.get = function (host, p) {
    const r = fs.resolve(host, normalize(p));
    return r.host.fs[r.path];
  };
  fs.exists = function (host, p) { return fs.get(host, p) !== undefined; };
  fs.isDir = function (host, p) { const n = fs.get(host, p); return !!n && n.type === 'dir'; };
  fs.isFile = function (host, p) { const n = fs.get(host, p); return !!n && n.type === 'file'; };

  fs.read = function (host, p) {
    const n = fs.get(host, p);
    if (!n) fail('No such file or directory');
    if (n.type === 'dir') fail('Is a directory');
    return n.content || '';
  };

  fs.list = function (host, p) {
    const r = fs.resolve(host, normalize(p));
    const n = r.host.fs[r.path];
    if (!n) fail('No such file or directory');
    if (n.type !== 'dir') fail('Not a directory');
    const prefix = r.path === '/' ? '/' : r.path + '/';
    const names = [];
    for (const k of Object.keys(r.host.fs)) {
      if (k === r.path || !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest && rest.indexOf('/') === -1) names.push(rest);
    }
    return names.sort();
  };

  function whoOf(host, who) {
    if (who) return who;
    return { uid: 0, gid: 0 };
  }

  // Create a file or directory. Setgid parent dirs pass their group to children and
  // propagate the setgid bit to new subdirectories.
  fs.create = function (host, p, opts) {
    opts = opts || {};
    const type = opts.type || 'file';
    const target = fs.resolve(host, normalize(p));
    const h = target.host;
    const path = target.path;
    if (h.fs[path]) fail('File exists');
    const par = parentOf(path);
    if (par && !h.fs[par]) {
      if (!opts.parents) fail('No such file or directory');
      fs.create(h, par, { type: 'dir', parents: true, mode: 0o755, who: opts.who });
    } else if (par && h.fs[par].type !== 'dir') {
      fail('Not a directory');
    }
    const pdir = par ? h.fs[par] : null;
    const who = whoOf(h, opts.who);
    let gid = who.gid;
    let mode = opts.mode !== undefined ? opts.mode : (type === 'dir' ? 0o755 : 0o644);
    if (pdir && (pdir.mode & 0o2000)) {
      gid = pdir.gid;
      if (type === 'dir') mode |= 0o2000;
    }
    h.fs[path] = {
      type: type,
      mode: mode,
      uid: who.uid,
      gid: gid,
      content: type === 'file' ? (opts.content || '') : undefined,
    };
    return h.fs[path];
  };

  fs.write = function (host, p, content, opts) {
    opts = opts || {};
    const target = fs.resolve(host, normalize(p));
    const h = target.host;
    const path = target.path;
    const existing = h.fs[path];
    if (existing) {
      if (existing.type === 'dir') fail('Is a directory');
      existing.content = opts.append ? (existing.content || '') + content : content;
      return existing;
    }
    const node = fs.create(host, p, { type: 'file', content: content, who: opts.who });
    return node;
  };

  fs.remove = function (host, p, opts) {
    opts = opts || {};
    const target = fs.resolve(host, normalize(p));
    const h = target.host;
    const path = target.path;
    const n = h.fs[path];
    if (!n) fail('No such file or directory');
    if (path === '/') fail('Refusing to remove /');
    if (n.type === 'dir') {
      const children = Object.keys(h.fs).filter(k => k.startsWith(path + '/'));
      if (children.length && !opts.recursive) fail('Directory not empty');
      for (const k of children) delete h.fs[k];
    }
    delete h.fs[path];
  };

  fs.chmod = function (host, p, mode) {
    const n = fs.get(host, p);
    if (!n) fail('No such file or directory');
    n.mode = mode;
  };
  fs.chown = function (host, p, uid, gid) {
    const n = fs.get(host, p);
    if (!n) fail('No such file or directory');
    if (uid !== undefined && uid !== null) n.uid = uid;
    if (gid !== undefined && gid !== null) n.gid = gid;
  };

  fs.canAccess = function (host, user, p, op) {
    if (user === 'root') return true;
    const n = fs.get(host, p);
    if (!n) return false;
    const u = Sim.findUser(host, user);
    if (!u) return false;
    const bit = op === 'r' ? 4 : op === 'w' ? 2 : 1;
    let triad;
    if (n.uid === u.uid) triad = (n.mode >> 6) & 7;
    else if (Sim.userGroups(host, user).indexOf(groupName(host, n.gid)) !== -1) triad = (n.mode >> 3) & 7;
    else triad = n.mode & 7;
    return (triad & bit) !== 0;
  };

  fs.assertAccess = function (host, session, p, op) {
    if (!fs.canAccess(host, session.user, p, op)) fail('Permission denied');
  };

  function groupName(host, gid) {
    for (const [name, g] of Object.entries(host.groups || {})) if (g.gid === gid) return name;
    return null;
  }

  // ---------------------------------------------------------------- lookups
  Sim.findUser = function (host, name) {
    return host.users && host.users[name] ? Object.assign({ name: name }, host.users[name]) : undefined;
  };

  Sim.userGroups = function (host, name) {
    const u = host.users && host.users[name];
    if (!u) return [];
    const out = [];
    for (const [g, rec] of Object.entries(host.groups || {})) {
      if (rec.gid === u.gid || (rec.members || []).indexOf(name) !== -1) out.push(g);
    }
    return out;
  };

  Sim.fileLines = function (host, p) {
    const n = fs.get(host, p);
    if (!n || n.type !== 'file') return [];
    return (n.content || '').split('\n').map(l => l.trim()).filter(l => l && l[0] !== '#');
  };

  Sim.parseFstab = function (host) {
    return Sim.fileLines(host, '/etc/fstab').map(l => {
      const f = l.split(/\s+/);
      return { source: f[0], target: f[1], fstype: f[2] || 'auto', opts: f[3] || 'defaults',
               dump: Number(f[4] || 0), pass: Number(f[5] || 0) };
    }).filter(e => e.target);
  };

  Sim.parseExports = function (host) {
    return Sim.fileLines(host, '/etc/exports').map(l => {
      const f = l.split(/\s+/);
      const clients = f.slice(1).map(c => {
        const m = c.match(/^([^(]*)\(([^)]*)\)$/);
        return m ? { spec: m[1], opts: m[2] } : { spec: c, opts: 'ro' };
      });
      return { path: f[0], clients: clients };
    });
  };

  function ipInCidr(ip, cidr) {
    const [net, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const toInt = s => s.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((toInt(ip) & mask) >>> 0) === ((toInt(net) & mask) >>> 0);
  }

  // Exports only take effect when applied (exportfs -ra, or nfs-server start). The applied
  // list lives in host.active.exportsApplied and is cleared on reboot.
  Sim.exportAllows = function (serverHost, remotePath, clientIp) {
    const svc = serverHost.active && serverHost.active.services && serverHost.active.services['nfs-server'];
    if (!svc || !svc.active) return false;
    const rp = normalize(remotePath);
    for (const e of (serverHost.active.exportsApplied || [])) {
      const ep = normalize(e.path);
      if (!(rp === ep || rp.startsWith(ep === '/' ? '/' : ep + '/'))) continue;
      for (const c of e.clients) {
        if (c.spec === '*' || c.spec === clientIp) return true;
        if (c.spec.indexOf('/') !== -1 && ipInCidr(clientIp, c.spec)) return true;
      }
    }
    return false;
  };

  // ---------------------------------------------------------------- lab + hosts
  Sim.newHost = function (spec) {
    return {
      name: spec.name,
      hostname: spec.hostname,
      ip: spec.ip,
      fs: {},
      users: {},
      groups: {},
      disks: {},
      lvm: { pvs: {}, vgs: {}, lvs: {} },
      units: {},
      active: null,
    };
  };

  function makeDir(h, p, mode, uid, gid) {
    h.fs[p] = { type: 'dir', mode: mode, uid: uid || 0, gid: gid || 0 };
  }
  function makeFile(h, p, content, mode, uid, gid) {
    h.fs[p] = { type: 'file', mode: mode, uid: uid || 0, gid: gid || 0, content: content };
  }

  function seedHost(h) {
    makeDir(h, '/', 0o755);
    ['/bin', '/sbin', '/usr', '/usr/bin', '/usr/sbin', '/etc', '/etc/auto.master.d', '/etc/sudoers.d',
     '/etc/systemd', '/var', '/var/tmp', '/root', '/home', '/rhome', '/share', '/share/docs',
     '/mnt', '/mnt/nfs', '/mnt/docs', '/data', '/backup', '/common', '/opt', '/srv'].forEach(p => makeDir(h, p, 0o755));
    makeDir(h, '/root', 0o550);
    makeDir(h, '/tmp', 0o1777);
    makeDir(h, '/var/tmp', 0o1777);
    makeFile(h, '/bin/bash', '#!sim\n', 0o755);
    makeFile(h, '/bin/sh', '#!sim\n', 0o755);
    makeFile(h, '/sbin/nologin', '#!sim\n', 0o755);
    makeFile(h, '/etc/shells', '/bin/sh\n/bin/bash\n/sbin/nologin\n', 0o644);
    makeFile(h, '/etc/hostname', h.hostname + '\n', 0o644);
    makeFile(h, '/etc/hosts',
      '127.0.0.1 localhost localhost.localdomain\n' +
      '192.168.50.10 server.lab server\n' +
      '192.168.50.20 client.lab client\n', 0o644);
    makeFile(h, '/etc/fstab',
      '# /etc/fstab (simulated)\n' +
      '# <device>  <mountpoint>  <type>  <options>  <dump>  <pass>\n', 0o644);
    makeFile(h, '/etc/exports', '# /etc/exports\n', 0o644);
    makeFile(h, '/etc/auto.master',
      '# auto.master\n+dir:/etc/auto.master.d\n', 0o644);
    makeFile(h, '/etc/login.defs',
      'PASS_MAX_DAYS   99999\nPASS_MIN_DAYS   0\nPASS_MIN_LEN    5\nPASS_WARN_AGE   7\n' +
      'UID_MIN                  1000\nGID_MIN                  1000\n', 0o644);
    makeFile(h, '/etc/sudoers',
      'root    ALL=(ALL)       ALL\n%wheel  ALL=(ALL)       ALL\n#includedir /etc/sudoers.d\n', 0o440);

    h.groups = {
      root: { gid: 0, members: [] },
      bin: { gid: 1, members: [] },
      wheel: { gid: 10, members: [] },
      users: { gid: 100, members: [] },
      nobody: { gid: 65534, members: [] },
    };
    h.users = {
      root: { uid: 0, gid: 0, home: '/root', shell: '/bin/bash', pw: 'redhat', pwSetDay: 0,
              maxDays: 99999, minDays: 0, warnDays: 7, expire: null, locked: false, mustChange: false },
      nobody: { uid: 65534, gid: 65534, home: '/', shell: '/sbin/nologin', pw: '', pwSetDay: 0,
                maxDays: 99999, minDays: 0, warnDays: 7, expire: null, locked: true, mustChange: false },
    };
    h.units = { 'rpcbind': { enabled: true }, 'nfs-server': { enabled: false }, 'autofs': { enabled: false } };
    h.lvm = { pvs: {}, vgs: {}, lvs: {} };
    h.disks = {
      '/dev/loop0': { sizeMB: 1024, label: 'disk1', pv: false },
      '/dev/loop1': { sizeMB: 1024, label: 'disk2', pv: false },
      '/dev/loop2': { sizeMB: 1024, label: 'disk3', pv: false },
    };
    h.active = null;
  }

  Sim.buildLab = function () {
    const server = Sim.newHost({ name: 'server', hostname: 'server.lab', ip: '192.168.50.10' });
    const client = Sim.newHost({ name: 'client', hostname: 'client.lab', ip: '192.168.50.20' });
    seedHost(server);
    seedHost(client);
    // Server shares: /share and /share/docs contain sample content; /rhome exists for task 8.
    makeFile(server, '/share/readme.txt', 'Shared from server.lab\n', 0o644);
    makeFile(server, '/share/docs/manual.txt', 'Sample documentation\n', 0o644);
    return attachLabMethods({ hosts: { server: server, client: client } });
  };

  // JSON drops methods, so the lab's lookup method is re-attached after every load.
  function attachLabMethods(lab) {
    lab.host = function (key) {
      if (!key) return undefined;
      const k = String(key).toLowerCase();
      return lab.hosts[k] || Object.values(lab.hosts).find(h =>
        h.ip === k || h.hostname === k || h.name === k || h.hostname.split('.')[0] === k);
    };
    return lab;
  }

  // Runtime state is wiped and rebuilt from persistent state on every boot.
  Sim.reboot = function (lab) {
    lab = lab || Sim.lab;
    for (const h of Object.values(lab.hosts)) {
      h.active = { mounts: [], swaps: [], lvActive: {}, services: {}, exportsApplied: [], autofs: {}, bootErrors: [] };
    }
    const phases = [...new Set(Sim.bootSteps.map(s => s.phase))].sort((a, b) => a - b);
    for (const ph of phases) {
      for (const hostName of ['server', 'client']) {
        const h = lab.hosts[hostName];
        for (const step of Sim.bootSteps.filter(s => s.phase === ph)) {
          try { step.fn(h, lab); }
          catch (e) { h.active.bootErrors.push('phase ' + ph + ': ' + e.message); }
        }
      }
    }
  };

  // ---------------------------------------------------------------- persistence
  const STORE_KEY = 'rhlab.v1';
  Sim.save = function () {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(Sim.lab)); } catch (e) { /* private mode */ }
  };
  Sim.load = function () {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        Sim.lab = attachLabMethods(data);
        for (const h of Object.values(Sim.lab.hosts)) {
          if (!h.active) h.active = { mounts: [], swaps: [], lvActive: {}, services: {}, exportsApplied: [], autofs: {}, bootErrors: [] };
        }
        return true;
      }
    } catch (e) { /* corrupt state: fall through to a fresh lab */ }
    return false;
  };
  Sim.resetLab = function () {
    Sim.lab = Sim.buildLab();
    Sim.reboot(Sim.lab);
    Sim.save();
    return Sim.lab;
  };
  Sim.simulateReboot = function () {
    Sim.reboot(Sim.lab);
    Sim.save();
  };
  Sim.bootIfNeeded = function () {
    if (!Sim.load()) { Sim.lab = Sim.buildLab(); Sim.reboot(Sim.lab); Sim.save(); }
    return Sim.lab;
  };

  // ---------------------------------------------------------------- shell parser
  // Split a line on top-level separators (quotes respected). ops: ';', '&&', '||', '|'
  function splitTop(line, seps) {
    const parts = [];
    let cur = '';
    let q = null;
    let i = 0;
    let pendingOp = null;
    while (i < line.length) {
      const c = line[i];
      if (q) {
        cur += c;
        if (c === q) q = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'") { q = c; cur += c; i++; continue; }
      let matched = null;
      for (const s of seps) {
        if (line.startsWith(s, i)) { matched = s; break; }
      }
      if (matched) {
        parts.push({ text: cur.trim(), op: pendingOp });
        pendingOp = matched;
        cur = '';
        i += matched.length;
        continue;
      }
      cur += c;
      i++;
    }
    parts.push({ text: cur.trim(), op: pendingOp });
    return parts.filter(p => p.text.length > 0 || p.op);
  }

  function tokenize(text, session, host) {
    const tokens = [];
    let cur = null;
    const push = () => { if (cur !== null) { tokens.push({ type: 'word', value: cur }); cur = null; } };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t') { push(); i++; continue; }
      if (c === '>' ) {
        push();
        if (text[i + 1] === '>') { tokens.push({ type: 'op', value: '>>' }); i += 2; }
        else { tokens.push({ type: 'op', value: '>' }); i++; }
        continue;
      }
      if (c === '|') { push(); tokens.push({ type: 'op', value: '|' }); i++; continue; }
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
        cur = (cur || '') + body;
        i = end === -1 ? text.length : end + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let body = '';
        while (j < text.length && text[j] !== '"') {
          // Inside double quotes a backslash only escapes " \ $ (as in bash); otherwise it is kept.
          if (text[j] === '\\' && j + 1 < text.length && '"\\$'.indexOf(text[j + 1]) !== -1) { body += text[j + 1]; j += 2; continue; }
          if (text[j] === '$') { const v = readVar(text, j, session, host); body += v.value; j = v.end; continue; }
          body += text[j]; j++;
        }
        cur = (cur || '') + body;
        i = j + 1;
        continue;
      }
      if (c === '\\' && i + 1 < text.length) { cur = (cur || '') + text[i + 1]; i += 2; continue; }
      if (c === '$') {
        const v = readVar(text, i, session, host);
        cur = (cur || '') + v.value;
        i = v.end;
        continue;
      }
      cur = (cur || '') + c;
      i++;
    }
    push();
    return tokens;
  }

  function readVar(text, i, session, host) {
    if (text[i + 1] === '?') return { value: String(session.lastStatus || 0), end: i + 2 };
    let j = i + 1;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
    const name = text.slice(i + 1, j);
    if (!name) return { value: '$', end: i + 1 };
    let value = '';
    if (name === 'USER') value = session.user;
    else if (name === 'HOME') { const u = Sim.findUser(host, session.user); value = u ? u.home : '/root'; }
    else if (name === 'PWD') value = session.cwd;
    else if (name === 'HOSTNAME') value = host.hostname;
    else value = (session.env && session.env[name]) || '';
    return { value: value, end: j };
  }

  // Run one pipeline (cmd | cmd | cmd > file). Returns exit code; writes into res.
  function runPipeline(host, session, text, res) {
    const stages = splitTop(text, ['|']).map(p => p.text);
    let stdin = null;
    let code = 0;
    for (let s = 0; s < stages.length; s++) {
      const last = s === stages.length - 1;
      const tokens = tokenize(stages[s], session, host);
      // redirection
      let redirect = null;
      let append = false;
      const words = [];
      for (let t = 0; t < tokens.length; t++) {
        const tk = tokens[t];
        if (tk.type === 'op' && (tk.value === '>' || tk.value === '>>')) {
          const target = tokens[t + 1];
          if (!target || target.type !== 'word') { res.err += 'bash: syntax error near unexpected token\n'; return 2; }
          redirect = target.value;
          append = tk.value === '>>';
          t++;
        } else if (tk.type === 'word') {
          words.push(tk.value);
        }
      }
      if (words.length === 0) { code = 0; stdin = ''; continue; }
      const name = words[0];
      const args = words.slice(1);
      let stdout = '';
      let stderr = '';
      const fn = Sim.commands[name];
      if (!fn) {
        stderr += 'bash: ' + name + ': command not found\n';
        code = 127;
      } else {
        const ctx = {
          name: name,
          args: args,
          raw: stages[s],
          host: host,
          lab: Sim.lab,
          session: session,
          stdin: stdin,
          out: function (x) { stdout += x; },
          err: function (x) { stderr += x; },
          cwd: function () { return session.cwd; },
          who: function () {
            const u = Sim.findUser(host, session.user);
            return { uid: u ? u.uid : 0, gid: u ? u.gid : 0, user: session.user };
          },
          println: function (x) { stdout += (x === undefined ? '' : x) + '\n'; },
        };
        try {
          const r = fn(ctx);
          code = typeof r === 'number' ? r : 0;
        } catch (e) {
          stderr += name + ': ' + (e.message || String(e)) + '\n';
          code = 1;
        }
      }
      res.err += stderr;
      if (redirect) {
        try {
          const who = { uid: 0, gid: 0 };
          const u = Sim.findUser(host, session.user);
          if (u) { who.uid = u.uid; who.gid = u.gid; }
          const absTarget = fs.abs(host, session, redirect);
          const parent = fs.parent(absTarget);
          if (session.user !== 'root' && parent && fs.exists(host, parent)) {
            if (!fs.exists(host, absTarget)) fs.assertAccess(host, session, parent, 'w');
            else fs.assertAccess(host, session, absTarget, 'w');
          }
          fs.write(host, absTarget, stdout, { append: append, who: who });
        } catch (e) {
          res.err += 'bash: ' + redirect + ': ' + e.message + '\n';
          code = 1;
        }
        stdin = '';
        if (!last) { /* redirected output does not feed the pipe */ }
      } else if (last) {
        res.out += stdout;
      } else {
        stdin = stdout;
      }
    }
    return code;
  }

  // Run a full command line as `session.user` on the named host.
  Sim.exec = function (hostName, line, session) {
    const host = Sim.lab.host(hostName);
    session = session || { user: 'root', cwd: '/root' };
    if (session.lastStatus === undefined) session.lastStatus = 0;
    const res = { out: '', err: '', code: 0 };
    if (!host) { res.err = 'no such host: ' + hostName + '\n'; res.code = 1; return res; }
    const groups = splitTop(line, [';', '&&', '||']);
    let last = 0;
    const prevActive = Sim.shellActive;
    Sim.shellActive = true;
    try {
      for (const g of groups) {
        if (g.op === '&&' && last !== 0) continue;
        if (g.op === '||' && last === 0) continue;
        if (!g.text) continue;
        last = runPipeline(host, session, g.text, res);
        session.lastStatus = last;
      }
    } finally {
      Sim.shellActive = prevActive;
    }
    res.code = last;
    return res;
  };

  // ---------------------------------------------------------------- core commands
  const reg = Sim.register;

  reg('echo', function (ctx) {
    let args = ctx.args.slice();
    let nl = true;
    if (args[0] === '-n') { nl = false; args = args.slice(1); }
    ctx.out(args.join(' ') + (nl ? '\n' : ''));
    return 0;
  });

  reg('printf', function (ctx) {
    ctx.out(ctx.args.join(' ').replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
    return 0;
  });

  reg('cat', function (ctx) {
    if (ctx.args.length === 0) { ctx.out(ctx.stdin || ''); return 0; }
    let code = 0;
    for (const a of ctx.args) {
      try {
        const p = fs.abs(ctx.host, ctx.session, a);
        ctx.session && fs.assertAccess(ctx.host, ctx.session, p, 'r');
        ctx.out(fs.read(ctx.host, p));
      } catch (e) { ctx.err('cat: ' + a + ': ' + e.message + '\n'); code = 1; }
    }
    return code;
  });

  reg('grep', function (ctx) {
    const flags = ctx.args.filter(a => a[0] === '-');
    const rest = ctx.args.filter(a => a[0] !== '-');
    const quiet = flags.some(f => f.indexOf('q') !== -1);
    const invert = flags.some(f => f.indexOf('v') !== -1);
    const pattern = rest[0];
    if (pattern === undefined) throw new Error('no pattern');
    const re = new RegExp(pattern);
    let input = '';
    if (rest.length > 1) {
      for (const f of rest.slice(1)) input += fs.read(ctx.host, fs.abs(ctx.host, ctx.session, f));
    } else input = ctx.stdin || '';
    const lines = input.split('\n').filter(l => l.length);
    const matched = lines.filter(l => re.test(l) !== invert);
    if (!quiet) matched.forEach(l => ctx.out(l + '\n'));
    return matched.length ? 0 : 1;
  });

  reg('wc', function (ctx) {
    const input = ctx.stdin || '';
    const n = input.split('\n').filter(l => l.length).length;
    if (ctx.args.indexOf('-l') !== -1) ctx.out(n + '\n');
    else ctx.out(n + '\n');
    return 0;
  });

  reg('tee', function (ctx) {
    const append = ctx.args.indexOf('-a') !== -1;
    const files = ctx.args.filter(a => a !== '-a');
    ctx.out(ctx.stdin || '');
    for (const f of files) {
      try { fs.write(ctx.host, fs.abs(ctx.host, ctx.session, f), ctx.stdin || '', { append: append, who: ctx.who() }); }
      catch (e) { ctx.err('tee: ' + f + ': ' + e.message + '\n'); }
    }
    return 0;
  });

  reg('ls', function (ctx) {
    const flags = ctx.args.filter(a => a[0] === '-').join('');
    const targets = ctx.args.filter(a => a[0] !== '-');
    const long = flags.indexOf('l') !== -1;
    const all = flags.indexOf('a') !== -1;
    const showDirOnly = flags.indexOf('d') !== -1;
    if (targets.length === 0) targets.push('.');
    let code = 0;
    for (const t of targets) {
      const p = fs.abs(ctx.host, ctx.session, t);
      try {
        const node = fs.get(ctx.host, p);
        if (!node) throw new Error('No such file or directory');
        if (node.type === 'file' || showDirOnly) {
          ctx.out((long ? modeStr(node) + ' ' + ownerStr(ctx.host, node) + ' ' + t : t) + '\n');
          continue;
        }
        let names = fs.list(ctx.host, p);
        if (all) names = ['.', '..'].concat(names);
        if (targets.length > 1) ctx.out(t + ':\n');
        if (long) {
          for (const n of names) {
            const child = fs.get(ctx.host, p === '/' ? '/' + n : p + '/' + n);
            ctx.out(modeStr(child || { type: 'dir', mode: 0o755 }) + ' ' + ownerStr(ctx.host, child || {}) + ' ' + n + '\n');
          }
        } else if (names.length) {
          ctx.out(names.join('  ') + '\n');
        }
      } catch (e) {
        ctx.err('ls: cannot access ' + t + ': ' + e.message + '\n');
        code = 2;
      }
    }
    return code;
  });

  function modeStr(node) {
    const t = node.type === 'dir' ? 'd' : '-';
    const m = node.mode || 0;
    const bit = (v, ch) => (v ? ch : '-');
    const triad = (shift, special, sch) => {
      const v = (m >> shift) & 7;
      const r = bit(v & 4, 'r'), w = bit(v & 2, 'w');
      let x = bit(v & 1, 'x');
      if (special) x = (v & 1) ? sch : sch.toUpperCase();
      return r + w + x;
    };
    return t + triad(6, m & 0o4000, 's') + triad(3, m & 0o2000, 's') + triad(0, m & 0o1000, 't');
  }

  function ownerStr(host, node) {
    const u = Object.entries(host.users || {}).find(([, r]) => r.uid === node.uid);
    const g = Object.entries(host.groups || {}).find(([, r]) => r.gid === node.gid);
    return (u ? u[0] : String(node.uid)) + ' ' + (g ? g[0] : String(node.gid));
  }

  reg('cd', function (ctx) {
    const target = ctx.args[0] || '~';
    const p = fs.abs(ctx.host, ctx.session, target);
    if (!fs.isDir(ctx.host, p)) {
      ctx.err('bash: cd: ' + target + ': No such file or directory\n');
      return 1;
    }
    ctx.session.cwd = p;
    return 0;
  });

  reg('pwd', function (ctx) { ctx.out(ctx.cwd() + '\n'); return 0; });

  reg('mkdir', function (ctx) {
    const parents = ctx.args.indexOf('-p') !== -1;
    const names = ctx.args.filter(a => a[0] !== '-');
    let code = 0;
    for (const n of names) {
      try {
        const p = fs.abs(ctx.host, ctx.session, n);
        if (parents && fs.isDir(ctx.host, p)) continue;
        fs.create(ctx.host, p, { type: 'dir', parents: parents, who: ctx.who() });
      } catch (e) { ctx.err('mkdir: cannot create directory ' + n + ': ' + e.message + '\n'); code = 1; }
    }
    return code;
  });

  reg('touch', function (ctx) {
    let code = 0;
    for (const n of ctx.args) {
      try {
        const p = fs.abs(ctx.host, ctx.session, n);
        if (!fs.exists(ctx.host, p)) fs.create(ctx.host, p, { type: 'file', who: ctx.who() });
      } catch (e) { ctx.err('touch: cannot touch ' + n + ': ' + e.message + '\n'); code = 1; }
    }
    return code;
  });

  reg('rm', function (ctx) {
    const recursive = ctx.args.some(a => /^-[a-zA-Z]*[rR]/.test(a));
    const force = ctx.args.some(a => /^-[a-zA-Z]*f/.test(a));
    let code = 0;
    for (const n of ctx.args.filter(a => a[0] !== '-')) {
      try {
        const p = fs.abs(ctx.host, ctx.session, n);
        fs.assertAccess(ctx.host, ctx.session, fs.parent(p), 'w');
        fs.remove(ctx.host, p, { recursive: recursive });
      } catch (e) { if (!force) { ctx.err('rm: cannot remove ' + n + ': ' + e.message + '\n'); code = 1; } }
    }
    return code;
  });

  reg('cp', function (ctx) {
    const recursive = ctx.args.some(a => /^-[a-zA-Z]*[rR]/.test(a));
    const names = ctx.args.filter(a => a[0] !== '-');
    if (names.length < 2) throw new Error('missing destination file operand');
    const dst = fs.abs(ctx.host, ctx.session, names[names.length - 1]);
    const srcs = names.slice(0, -1);
    const copyTree = (from, to) => {
      const node = fs.get(ctx.host, from);
      if (!node) throw new Error('cannot stat ' + from + ': No such file or directory');
      if (node.type === 'dir') {
        if (!recursive) throw new Error('-r not specified; omitting directory ' + from);
        fs.create(ctx.host, to, { type: 'dir', who: ctx.who(), mode: node.mode });
        for (const c of fs.list(ctx.host, from)) copyTree(from + '/' + c, to + '/' + c);
      } else {
        fs.write(ctx.host, to, node.content || '', { who: ctx.who() });
      }
    };
    let code = 0;
    const dstIsDir = fs.isDir(ctx.host, dst);
    for (const s of srcs) {
      try {
        const from = fs.abs(ctx.host, ctx.session, s);
        const to = dstIsDir ? dst + '/' + from.split('/').pop() : dst;
        copyTree(from, to);
      } catch (e) { ctx.err('cp: ' + e.message + '\n'); code = 1; }
    }
    return code;
  });

  reg('mv', function (ctx) {
    const names = ctx.args.filter(a => a[0] !== '-');
    if (names.length !== 2) throw new Error('usage: mv SRC DST');
    const from = fs.abs(ctx.host, ctx.session, names[0]);
    let to = fs.abs(ctx.host, ctx.session, names[1]);
    if (fs.isDir(ctx.host, to)) to = to + '/' + from.split('/').pop();
    const node = fs.get(ctx.host, from);
    if (!node) throw new Error('cannot stat ' + names[0] + ': No such file or directory');
    fs.write(ctx.host, to, node.content || '', { who: ctx.who() });
    fs.get(ctx.host, to).mode = node.mode;
    fs.remove(ctx.host, from, { recursive: true });
    return 0;
  });

  // chmod: octal (755) or symbolic (u+x, g=rwx, o-w, +t, g+s, a+r)
  reg('chmod', function (ctx) {
    const recursive = ctx.args.indexOf('-R') !== -1;
    const args = ctx.args.filter(a => a !== '-R');
    const modeArg = args[0];
    const targets = args.slice(1);
    if (!modeArg) throw new Error('missing operand');
    for (const t of targets) {
      const p = fs.abs(ctx.host, ctx.session, t);
      const apply = (path) => {
        const node = fs.get(ctx.host, path);
        if (!node) throw new Error('cannot access ' + t + ': No such file or directory');
        if (/^[0-7]{3,4}$/.test(modeArg)) {
          node.mode = parseInt(modeArg, 8);
        } else {
          const m = modeArg.match(/^([ugoa]*)([+\-=])([rwxstugo]+)$/);
          if (!m) throw new Error('invalid mode: ' + modeArg);
          const who = m[1] || 'a';
          const op = m[2];
          const perms = m[3];
          let bits = 0;
          for (const ch of perms) {
            if (ch === 'r') bits |= 4;
            if (ch === 'w') bits |= 2;
            if (ch === 'x') bits |= 1;
          }
          const apply2 = (shift, extra) => {
            let mask = (bits << shift) | extra;
            if (op === '+') node.mode |= mask;
            else if (op === '-') node.mode &= ~mask;
            else { node.mode &= ~(0o7 << shift); node.mode |= (bits << shift) | extra; }
          };
          const specials = {
            u: perms.indexOf('s') !== -1 ? 0o4000 : 0,
            g: perms.indexOf('s') !== -1 ? 0o2000 : 0,
          };
          const sticky = perms.indexOf('t') !== -1 ? 0o1000 : 0;
          if (who.indexOf('u') !== -1 || who.indexOf('a') !== -1) apply2(6, specials.u);
          if (who.indexOf('g') !== -1 || who.indexOf('a') !== -1) apply2(3, specials.g);
          if (who.indexOf('o') !== -1 || who.indexOf('a') !== -1) apply2(0, 0);
          if (sticky) { if (op === '-') node.mode &= ~0o1000; else node.mode |= 0o1000; }
        }
        if (recursive && node.type === 'dir') {
          const prefix = path === '/' ? '/' : path + '/';
          for (const k of Object.keys(ctx.host.fs)) {
            if (k.startsWith(prefix)) apply2b(k);
          }
        }
      };
      const apply2b = (k) => { try { apply(k); } catch (e) { /* ignore child errors */ } };
      apply(p);
    }
    return 0;
  });

  // chown user[:group] path...
  reg('chown', function (ctx) {
    const recursive = ctx.args.indexOf('-R') !== -1;
    const args = ctx.args.filter(a => a !== '-R');
    const spec = args[0];
    if (!spec) throw new Error('missing operand');
    const [uname, gname] = spec.split(':');
    const u = uname ? Sim.findUser(ctx.host, uname) : undefined;
    if (uname && !u) throw new Error("invalid user: '" + uname + "'");
    const gKey = gname !== undefined ? gname : undefined;
    const grp = gKey ? ctx.host.groups[gKey] : undefined;
    if (gKey && !grp) throw new Error("invalid group: '" + gKey + "'");
    for (const t of args.slice(1)) {
      const p = fs.abs(ctx.host, ctx.session, t);
      const targets = [p];
      if (recursive) {
        const prefix = p === '/' ? '/' : p + '/';
        for (const k of Object.keys(ctx.host.fs)) if (k.startsWith(prefix)) targets.push(k);
      }
      for (const tp of targets) {
        fs.chown(ctx.host, tp, u ? u.uid : undefined, grp ? grp.gid : undefined);
      }
    }
    return 0;
  });

  reg('chgrp', function (ctx) {
    const recursive = ctx.args.indexOf('-R') !== -1;
    const args = ctx.args.filter(a => a !== '-R');
    const g = ctx.host.groups[args[0]];
    if (!g) throw new Error("invalid group: '" + args[0] + "'");
    for (const t of args.slice(1)) {
      const p = fs.abs(ctx.host, ctx.session, t);
      const targets = [p];
      if (recursive) {
        const prefix = p === '/' ? '/' : p + '/';
        for (const k of Object.keys(ctx.host.fs)) if (k.startsWith(prefix)) targets.push(k);
      }
      for (const tp of targets) fs.chown(ctx.host, tp, undefined, g.gid);
    }
    return 0;
  });

  reg('whoami', function (ctx) { ctx.out(ctx.session.user + '\n'); return 0; });
  reg('hostname', function (ctx) { ctx.out(ctx.host.hostname.split('.')[0] + '\n'); return 0; });
  reg('hostnamectl', function (ctx) {
    if (ctx.args[0] === 'set-hostname') {
      const name = ctx.args[1];
      if (!name) throw new Error('missing hostname');
      ctx.host.hostname = name;
      fs.write(ctx.host, '/etc/hostname', name + '\n');
      return 0;
    }
    ctx.out('   Static hostname: ' + ctx.host.hostname + '\n');
    return 0;
  });
  reg('date', function (ctx) { ctx.out(new Date().toString() + '\n'); return 0; });
  reg('clear', function () { return 0; });
  reg('true', function () { return 0; });
  reg('false', function () { return 1; });
  reg('sync', function () { return 0; });
  reg('exit', function () { return 0; });
  reg('help', function (ctx) {
    ctx.out('Simulated RHEL shell. Commands: ' + Object.keys(Sim.commands).sort().join(' ') + '\n');
    return 0;
  });

  // Boot: nothing in core itself; modules add steps via Sim.bootStep.
})(window);
