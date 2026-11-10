/*
 * RHLab networking module: systemctl (rpcbind, nfs-server, autofs), exportfs, showmount,
 * ping, autofs maps and automount-on-access. Plain browser JS, loaded after core.js.
 */
(function () {
  'use strict';

  const Sim = window.Sim;

  // ---------------------------------------------------------------- units
  const UNIT_DESC = {
    'rpcbind': 'RPC bind service',
    'nfs-server': 'NFS server and services',
    'autofs': 'Automounts filesystems on demand',
  };
  const UNIT_ORDER = ['rpcbind', 'nfs-server', 'autofs'];

  function unitArg(a) {
    const name = a.replace(/\.service$/, '');
    if (!Object.prototype.hasOwnProperty.call(UNIT_DESC, name)) throw new Error('Unit ' + name + '.service not found.');
    return name;
  }

  function unitRec(host, name) {
    if (!host.units[name]) host.units[name] = { enabled: false };
    return host.units[name];
  }

  function svc(host, name) {
    if (!host.active.services) host.active.services = {};
    if (!host.active.services[name]) host.active.services[name] = { active: false };
    return host.active.services[name];
  }

  function isActive(host, name) {
    const s = host.active && host.active.services && host.active.services[name];
    return !!(s && s.active);
  }

  // ---------------------------------------------------------------- autofs maps
  // Parses /etc/auto.master (+ /etc/auto.master.d/*) and the map files it names.
  function readMap(host, file) {
    if (!Sim.fs.isFile(host, file)) throw new Error('Job for autofs.service failed: ' + file + ': No such file or directory');
    const entries = [];
    for (const l of Sim.fileLines(host, file)) {
      const f = l.split(/\s+/);
      let i = 1;
      let opts = '';
      if (f[i] && f[i][0] === '-') { opts = f[i].slice(1); i++; }
      if (f[i]) entries.push({ key: f[0], opts: opts, location: f[i] });
    }
    return entries;
  }

  function parseAutofs(host) {
    const lines = [];
    for (const l of Sim.fileLines(host, '/etc/auto.master')) {
      if (l.indexOf('+dir:') === 0) {
        const dir = l.slice(5).trim();
        if (Sim.fs.isDir(host, dir)) {
          for (const f of Sim.fs.list(host, dir)) lines.push(...Sim.fileLines(host, dir + '/' + f));
        }
      } else {
        lines.push(l);
      }
    }
    const am = { indirect: [], direct: [], mounted: [] };
    for (const l of lines) {
      const f = l.split(/\s+/);
      if (f.length < 2) continue;
      const entries = readMap(host, f[1]);
      if (f[0] === '/-') am.direct.push(...entries);
      else am.indirect.push({ mount: f[0], keys: entries });
    }
    return am;
  }

  // ---------------------------------------------------------------- start / stop
  function startUnit(host, name) {
    if (isActive(host, name)) return;
    if (name === 'rpcbind') {
      svc(host, name).active = true;
    } else if (name === 'nfs-server') {
      if (!isActive(host, 'rpcbind')) {
        throw new Error('Job for nfs-server.service failed because rpcbind.service is not active.');
      }
      host.active.exportsApplied = Sim.parseExports(host);
      svc(host, name).active = true;
    } else if (name === 'autofs') {
      host.active.autofs = parseAutofs(host);
      svc(host, name).active = true;
    }
  }

  function stopUnit(host, name) {
    if (name === 'nfs-server') {
      host.active.exportsApplied = [];
    } else if (name === 'autofs') {
      // Unmount what automount created, like a real autofs stop does.
      const am = host.active.autofs;
      const gone = (am && am.mounted) || [];
      const mounts = host.active.mounts;
      for (let i = mounts.length - 1; i >= 0; i--) {
        if (gone.indexOf(mounts[i].target) !== -1) mounts.splice(i, 1);
      }
      host.active.autofs = null;
    }
    svc(host, name).active = false;
  }

  function statusText(host, name) {
    const on = isActive(host, name);
    const enabled = unitRec(host, name).enabled;
    return '● ' + name + '.service - ' + UNIT_DESC[name] + '\n' +
      '   Loaded: loaded (/usr/lib/systemd/system/' + name + '.service; ' + (enabled ? 'enabled' : 'disabled') + ')\n' +
      '   Active: ' + (on ? 'active (running)' : 'inactive (dead)') + '\n';
  }

  // ---------------------------------------------------------------- systemctl
  Sim.register('systemctl', function (ctx) {
    const h = ctx.host;
    const flags = ctx.args.filter(a => a[0] === '-');
    const words = ctx.args.filter(a => a[0] !== '-');
    const op = words[0];
    const now = flags.indexOf('--now') !== -1;
    if (!op) throw new Error('Too few arguments.');
    const names = words.slice(1).map(unitArg);
    const needUnits = () => { if (!names.length) throw new Error('Too few arguments.'); };

    switch (op) {
      case 'start':
        needUnits();
        names.forEach(n => startUnit(h, n));
        return 0;
      case 'stop':
        needUnits();
        names.forEach(n => stopUnit(h, n));
        return 0;
      case 'restart':
      case 'reload':
        needUnits();
        names.forEach(n => { stopUnit(h, n); startUnit(h, n); });
        return 0;
      case 'enable':
        needUnits();
        names.forEach(n => { unitRec(h, n).enabled = true; if (now) startUnit(h, n); });
        return 0;
      case 'disable':
        needUnits();
        names.forEach(n => { unitRec(h, n).enabled = false; if (now) stopUnit(h, n); });
        return 0;
      case 'status': {
        const list = names.length ? names : UNIT_ORDER;
        let code = 0;
        list.forEach((n, i) => {
          ctx.out((i ? '\n' : '') + statusText(h, n));
          if (!isActive(h, n)) code = 3;
        });
        return code;
      }
      case 'is-active': {
        needUnits();
        let code = 0;
        names.forEach(n => {
          const on = isActive(h, n);
          ctx.out((on ? 'active' : 'inactive') + '\n');
          if (!on) code = 3;
        });
        return code;
      }
      case 'is-enabled': {
        needUnits();
        let code = 0;
        names.forEach(n => {
          const on = unitRec(h, n).enabled;
          ctx.out((on ? 'enabled' : 'disabled') + '\n');
          if (!on) code = 1;
        });
        return code;
      }
      case 'daemon-reload':
        return 0;
      default:
        throw new Error("Unknown operation '" + op + "'.");
    }
  });

  // ---------------------------------------------------------------- exportfs / showmount
  function clientList(e) {
    return e.clients.map(c => c.spec + '(' + c.opts + ')').join(' ');
  }

  Sim.register('exportfs', function (ctx) {
    const flags = ctx.args.filter(a => a[0] === '-').map(a => a.slice(1)).join('');
    const bad = flags.replace(/[rav]/g, '');
    if (bad) throw new Error("invalid option -- '" + bad[0] + "'");
    if (flags.indexOf('r') !== -1 || flags.indexOf('a') !== -1) {
      ctx.host.active.exportsApplied = Sim.parseExports(ctx.host);
      return 0;
    }
    for (const e of ctx.host.active.exportsApplied || []) ctx.out(e.path + '\t' + clientList(e) + '\n');
    return 0;
  });

  // Hosts named localhost/127.0.0.1 are the machine the command runs on.
  function resolveHost(ctx, name) {
    if (name === 'localhost' || name === '127.0.0.1') return ctx.host;
    return ctx.lab.host(name);
  }

  Sim.register('showmount', function (ctx) {
    const flags = ctx.args.filter(a => a[0] === '-').join('');
    const words = ctx.args.filter(a => a[0] !== '-');
    if (flags.indexOf('e') === -1) throw new Error('usage: showmount -e HOST');
    const name = words[0] || 'localhost';
    const target = resolveHost(ctx, name);
    if (!target) throw new Error('Host not found');
    if (!isActive(target, 'nfs-server')) throw new Error('clnt_create: RPC: Program not registered');
    ctx.out('Export list for ' + name + ':\n');
    for (const e of target.active.exportsApplied || []) ctx.out(e.path + '  ' + clientList(e) + '\n');
    return 0;
  });

  // ---------------------------------------------------------------- ping
  function resolveIp(ctx, name) {
    const hit = Sim.fileLines(ctx.host, '/etc/hosts')
      .map(l => l.split(/\s+/))
      .find(f => f.slice(1).indexOf(name) !== -1);
    if (hit) return hit[0];
    const h = ctx.lab.host(name);
    return h ? h.ip : null;
  }

  Sim.register('ping', function (ctx) {
    let count = 4;
    const words = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-c') count = Number(ctx.args[++i]);
      else if (a[0] !== '-') words.push(a);
    }
    if (!words.length) throw new Error('usage: ping [-c count] destination');
    if (!(count >= 1)) throw new Error('bad number of packets to transmit');
    const name = words[0];
    const ip = resolveIp(ctx, name);
    if (!ip) {
      ctx.err('ping: ' + name + ': Name or service not known\n');
      return 2;
    }
    ctx.out('PING ' + name + ' (' + ip + ') 56(84) bytes of data.\n');
    for (let i = 1; i <= count; i++) {
      ctx.out('64 bytes from ' + name + ' (' + ip + '): icmp_seq=' + i + ' ttl=64 time=0.1 ms\n');
    }
    ctx.out('\n--- ' + name + ' ping statistics ---\n' +
      count + ' packets transmitted, ' + count + ' received, 0% packet loss, time ' + (count * 1000 - 1000) + 'ms\n' +
      'rtt min/avg/max/mdev = 0.100/0.100/0.100/0.000 ms\n');
    return 0;
  });

  // ---------------------------------------------------------------- automount on access
  // Adds an NFS mount record for target if the server allows this host. Records the target in
  // am.mounted so that a later autofs stop can unmount it.
  function automount(host, am, target, entry, sub) {
    const mounts = host.active.mounts;
    if (mounts.some(m => m.target === target)) return;
    const loc = sub === undefined ? entry.location : entry.location.split('&').join(sub);
    const idx = loc.indexOf(':');
    if (idx < 1) return;
    const srvName = loc.slice(0, idx);
    const rpath = loc.slice(idx + 1);
    const srv = Sim.lab.host(srvName);
    if (!srv || !Sim.exportAllows(srv, rpath, host.ip)) return;
    if (!Sim.fs.exists(host, target)) Sim.fs.create(host, target, { type: 'dir', parents: true });
    mounts.push({ source: srvName + ':' + rpath, target: target, fstype: 'nfs', opts: entry.opts || 'defaults' });
    am.mounted.push(target);
  }

  // Core calls every access hook on path lookups from shell commands. The busy flag stops the
  // lookups made inside automount (fs.create, fs.exists) from re-entering this hook.
  let busy = false;
  Sim.accessHooks.push(function (host, p) {
    const am = host.active && host.active.autofs;
    const st = host.active && host.active.services && host.active.services.autofs;
    if (busy || !st || !st.active || !am || !am.indirect) return;
    busy = true;
    try {
      for (const im of am.indirect) {
        if (p.indexOf(im.mount + '/') !== 0) continue;
        const key = p.slice(im.mount.length + 1).split('/')[0];
        const entry = im.keys.find(k => k.key === key) || im.keys.find(k => k.key === '*');
        if (entry) automount(host, am, im.mount + '/' + key, entry, key);
      }
      for (const d of am.direct) {
        if (p === d.key || p.indexOf(d.key + '/') === 0) automount(host, am, d.key, d);
      }
    } finally {
      busy = false;
    }
  });

  // ---------------------------------------------------------------- boot
  Sim.bootStep(1, function (host) {
    for (const name of UNIT_ORDER) {
      if (!unitRec(host, name).enabled) continue;
      try { startUnit(host, name); }
      catch (e) { host.active.bootErrors.push('phase 1: ' + e.message); }
    }
  });
})();
