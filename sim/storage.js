/*
 * Storage commands for the simulated RHEL lab: LVM (pv/vg/lv), filesystems, mounts, swap and
 * block-device listings. Loaded after core.js. Persistent state: host.lvm, host.disks, /etc/fstab.
 * Runtime state (rebuilt on every reboot): host.active.mounts, swaps, lvActive, bootErrors.
 */
(function () {
  'use strict';
  const Sim = window.Sim;
  const fs = Sim.fs;
  const reg = Sim.register;
  const MB = 1024 * 1024;
  const FS_OVERHEAD = 0.03;   // df: share of an LV's size taken by filesystem metadata

  // ---------------------------------------------------------------- helpers
  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  // Minimal getopt. `valued` letters take an argument (-n NAME, -L1G, -nNAME); other letters are
  // flags and may be combined (-rf). Everything else is positional.
  function parseArgs(args, valued) {
    const opts = {}, flags = {}, pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { pos.push(...args.slice(i + 1)); break; }
      if (a.length < 2 || a[0] !== '-') { pos.push(a); continue; }
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (valued.indexOf(f) !== -1) { opts[f] = a.slice(j + 1) || args[++i]; break; }
        flags[f] = true;
      }
    }
    return { opts: opts, flags: flags, pos: pos };
  }

  function requireRoot(ctx) {
    if (ctx.session.user !== 'root') throw new Error('Permission denied');
  }
  const rootOnly = (fn) => (ctx) => { requireRoot(ctx); return fn(ctx); };

  // "512M", "1G", "2048" (MiB), "+1G" (relative). Returns {mb, rel}.
  function parseSize(s) {
    const m = /^(\+?)(\d+(?:\.\d+)?)([kmgt]?)$/i.exec(s || '');
    if (!m) throw new Error('invalid size: ' + s);
    const mult = { k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024, '': 1 }[m[3].toLowerCase()];
    return { mb: Number(m[2]) * mult, rel: m[1] === '+' };
  }

  // -L SIZE or -l EXTENTS -> {mb, rel}, rounded up to whole extents of the VG.
  function requestedSize(opts, pe) {
    let r;
    if (opts.L !== undefined) {
      const s = parseSize(opts.L);
      r = { mb: Math.ceil(s.mb / pe) * pe, rel: s.rel };
    } else if (opts.l !== undefined) {
      const m = /^(\+?)(\d+)$/.exec(opts.l);
      if (!m) throw new Error('invalid extents: ' + opts.l);
      r = { mb: Number(m[2]) * pe, rel: m[1] === '+' };
    } else {
      throw new Error('Please specify either size or extents (-L or -l)');
    }
    if (!(r.mb > 0)) throw new Error('invalid size: ' + (opts.L || opts.l));
    return r;
  }

  // 1536 -> "1.5G", 1024 -> "1G", 480 -> "480M"
  function human(mb) {
    if (mb < 1024) return mb + 'M';
    const g = mb / 1024;
    return (g % 1 === 0 ? g : g.toFixed(1)) + 'G';
  }

  // Left-aligned text table; rows[0] is the header.
  function table(rows) {
    const w = [];
    for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c).length); });
    return rows.map(r => r.map((c, i) => (i < r.length - 1 ? String(c).padEnd(w[i]) : String(c))).join('  ')).join('\n') + '\n';
  }

  function newUuid() {
    const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16); return s; };
    return hex(8) + '-' + hex(4) + '-' + hex(4) + '-' + hex(4) + '-' + hex(12);
  }

  // Bytes of file content stored under dir on this host. There is no real disk; this is "usage".
  function bytesUnder(h, dir) {
    const prefix = dir === '/' ? '/' : dir + '/';
    let n = 0;
    for (const p of Object.keys(h.fs)) {
      const node = h.fs[p];
      if (node.type === 'file' && p.indexOf(prefix) === 0) n += (node.content || '').length;
    }
    return n;
  }

  // Map a device name, UUID= or NFS source to an LV key 'VG/LV'. Returns null when no LV matches.
  function lvKey(h, src) {
    const lvs = h.lvm.lvs;
    if (!src) return null;
    if (src.indexOf('UUID=') === 0) {
      const u = src.slice(5);
      return Object.keys(lvs).find(k => lvs[k].uuid && lvs[k].uuid === u) || null;
    }
    if (src.indexOf('/dev/mapper/') === 0) {
      const dm = src.slice(12);
      return Object.keys(lvs).find(k => lvs[k].vg + '-' + lvs[k].name === dm) || null;
    }
    const key = src.indexOf('/dev/') === 0 ? src.slice(5) : src;
    return own(lvs, key) ? key : null;
  }

  function lvOrThrow(h, path) {
    const key = lvKey(h, path);
    if (!key) throw new Error('Logical volume ' + path + ' not found');
    return key;
  }

  // Same LV (or same NFS/other source string) as arg?
  function sameSource(h, src, arg) {
    const k = lvKey(h, src);
    return k !== null ? k === lvKey(h, arg) : src === arg;
  }

  const mountsOfLv = (h, key) => h.active.mounts.filter(m => lvKey(h, m.source) === key);

  // Size, allocation and free space of a VG, plus free space per PV (PVs fill in order).
  function vgInfo(h, name) {
    const v = h.lvm.vgs[name];
    const size = v.pvs.reduce((s, d) => s + h.disks[d].sizeMB, 0);
    const alloc = Object.values(h.lvm.lvs).reduce((s, l) => (l.vg === name ? s + l.sizeMB : s), 0);
    const pvFree = {};
    let left = alloc;
    for (const d of v.pvs) {
      const used = Math.min(h.disks[d].sizeMB, left);
      left -= used;
      pvFree[d] = h.disks[d].sizeMB - used;
    }
    return { peMB: v.peMB, size: size, free: size - alloc, pvFree: pvFree };
  }

  const noSpace = (vg, info, mb) => 'Volume group "' + vg + '" has insufficient free space (' +
    Math.floor(info.free / info.peMB) + ' extents): ' + (mb / info.peMB) + ' required.';

  // A device may join a VG only if it is a PV that is not in a VG yet.
  function checkFreePv(h, dev) {
    if (!h.disks[dev]) throw new Error('Device ' + dev + ' not found.');
    if (!own(h.lvm.pvs, dev)) throw new Error(dev + ' is not a physical volume');
    if (h.lvm.pvs[dev].vg) throw new Error('Physical volume "' + dev + '" is already in volume group "' + h.lvm.pvs[dev].vg + '"');
  }

  function resize(ctx, key, newMB) {
    const h = ctx.host;
    const lv = h.lvm.lvs[key];
    const pe = h.lvm.vgs[lv.vg].peMB;
    const old = lv.sizeMB;
    lv.sizeMB = newMB;
    ctx.out('Size of logical volume ' + key + ' changed from ' + human(old) + ' (' + old / pe + ' extents) to ' +
      human(newMB) + ' (' + newMB / pe + ' extents).\n');
    ctx.out('Logical volume ' + key + ' successfully resized.\n');
  }

  // ---------------------------------------------------------------- physical volumes
  reg('pvcreate', rootOnly(ctx => {
    const h = ctx.host;
    const devs = parseArgs(ctx.args, '').pos;
    if (!devs.length) throw new Error('Required device(s) not specified');
    for (const dev of devs) {
      if (!h.disks[dev]) throw new Error('Device ' + dev + ' not found (or ignored by filtering).');
      const pv = own(h.lvm.pvs, dev) ? h.lvm.pvs[dev] : null;
      if (pv && pv.vg) throw new Error('Can\'t initialize physical volume "' + dev + '" of volume group "' + pv.vg + '" without -ff');
      h.lvm.pvs[dev] = { vg: null };
      h.disks[dev].pv = true;
      ctx.out('Physical volume "' + dev + '" successfully created.\n');
    }
    return 0;
  }));

  reg('pvs', ctx => {
    const h = ctx.host;
    const rows = [['PV', 'VG', 'Fmt', 'Attr', 'PSize', 'PFree']];
    for (const dev of Object.keys(h.lvm.pvs).sort()) {
      const vg = h.lvm.pvs[dev].vg;
      const size = h.disks[dev].sizeMB;
      const free = vg ? vgInfo(h, vg).pvFree[dev] : size;
      rows.push([dev, vg || '', 'lvm2', vg ? 'a--' : '---', human(size), free ? human(free) : '0']);
    }
    ctx.out(table(rows));
    return 0;
  });

  // ---------------------------------------------------------------- volume groups
  reg('vgcreate', rootOnly(ctx => {
    const h = ctx.host;
    const a = parseArgs(ctx.args, 's');
    const name = a.pos[0];
    const devs = a.pos.slice(1);
    if (!name || !devs.length) throw new Error('Please provide a volume group name and at least one physical volume');
    if (own(h.lvm.vgs, name)) throw new Error('A volume group called ' + name + ' already exists.');
    if (new Set(devs).size !== devs.length) throw new Error('Duplicate physical volume given');
    devs.forEach(d => checkFreePv(h, d));
    const peMB = a.opts.s ? Math.ceil(parseSize(a.opts.s).mb) : 4;
    if (!(peMB > 0)) throw new Error('invalid physical extent size: ' + a.opts.s);
    h.lvm.vgs[name] = { peMB: peMB, pvs: devs.slice() };
    for (const d of devs) { h.lvm.pvs[d].vg = name; h.disks[d].pv = true; }
    ctx.out('Volume group "' + name + '" successfully created\n');
    return 0;
  }));

  reg('vgextend', rootOnly(ctx => {
    const h = ctx.host;
    const a = parseArgs(ctx.args, '');
    const name = a.pos[0];
    const devs = a.pos.slice(1);
    if (!name || !devs.length) throw new Error('Please provide a volume group name and at least one physical volume');
    if (!own(h.lvm.vgs, name)) throw new Error('Volume group "' + name + '" not found');
    if (new Set(devs).size !== devs.length) throw new Error('Duplicate physical volume given');
    devs.forEach(d => checkFreePv(h, d));
    for (const d of devs) {
      h.lvm.vgs[name].pvs.push(d);
      h.lvm.pvs[d].vg = name;
      h.disks[d].pv = true;
    }
    ctx.out('Volume group "' + name + '" successfully extended\n');
    return 0;
  }));

  reg('vgs', ctx => {
    const h = ctx.host;
    const rows = [['VG', '#PV', '#LV', 'Attr', 'VSize', 'VFree']];
    for (const name of Object.keys(h.lvm.vgs).sort()) {
      const info = vgInfo(h, name);
      const nLv = Object.values(h.lvm.lvs).filter(l => l.vg === name).length;
      rows.push([name, h.lvm.vgs[name].pvs.length, nLv, 'wz--n-', human(info.size), human(info.free)]);
    }
    ctx.out(table(rows));
    return 0;
  });

  // ---------------------------------------------------------------- logical volumes
  reg('lvcreate', rootOnly(ctx => {
    const h = ctx.host;
    const a = parseArgs(ctx.args, 'nLl');
    const vg = a.pos[0];
    const name = a.opts.n;
    if (!name) throw new Error('Please specify a logical volume name (-n)');
    if (!vg) throw new Error('Please specify a volume group');
    if (!own(h.lvm.vgs, vg)) throw new Error('Volume group "' + vg + '" not found');
    const key = vg + '/' + name;
    if (own(h.lvm.lvs, key)) throw new Error('Logical volume "' + name + '" already exists in volume group "' + vg + '"');
    const r = requestedSize(a.opts, h.lvm.vgs[vg].peMB);
    if (r.rel) throw new Error('invalid size: ' + (a.opts.L || a.opts.l));
    const info = vgInfo(h, vg);
    if (r.mb > info.free) throw new Error(noSpace(vg, info, r.mb));
    h.lvm.lvs[key] = { vg: vg, name: name, sizeMB: r.mb, fs: null, uuid: null };
    h.active.lvActive[key] = true;
    ctx.out('Logical volume "' + name + '" created.\n');
    return 0;
  }));

  reg('lvextend', rootOnly(ctx => {
    const h = ctx.host;
    const a = parseArgs(ctx.args, 'Ll');
    if (!a.pos[0]) throw new Error('Please specify a logical volume');
    const key = lvOrThrow(h, a.pos[0]);
    const lv = h.lvm.lvs[key];
    const info = vgInfo(h, lv.vg);
    const r = requestedSize(a.opts, info.peMB);
    const newMB = r.rel ? lv.sizeMB + r.mb : r.mb;
    if (newMB <= lv.sizeMB) {
      throw new Error('New size given (' + newMB + ' MiB) not larger than existing size (' + lv.sizeMB + ' MiB)');
    }
    if (newMB - lv.sizeMB > info.free) throw new Error(noSpace(lv.vg, info, newMB - lv.sizeMB));
    resize(ctx, key, newMB);
    return 0;
  }));

  reg('lvreduce', rootOnly(ctx => {
    const h = ctx.host;
    const a = parseArgs(ctx.args, 'Ll');
    if (!a.pos[0]) throw new Error('Please specify a logical volume');
    const key = lvOrThrow(h, a.pos[0]);
    const lv = h.lvm.lvs[key];
    const r = requestedSize(a.opts, h.lvm.vgs[lv.vg].peMB);
    if (r.rel) throw new Error('invalid size: ' + (a.opts.L || a.opts.l));
    if (r.mb >= lv.sizeMB) {
      throw new Error('New size given (' + r.mb + ' MiB) not smaller than existing size (' + lv.sizeMB + ' MiB)');
    }
    if (lv.fs === 'xfs') throw new Error('xfs: filesystems cannot be reduced');
    if (lv.fs === 'ext4' && mountsOfLv(h, key).length) throw new Error('ext4 filesystem must be unmounted to reduce');
    if (lv.fs && !a.flags.r) throw new Error('Use -r to resize the filesystem too');
    resize(ctx, key, r.mb);
    return 0;
  }));

  reg('lvs', ctx => {
    const h = ctx.host;
    const rows = [['LV', 'VG', 'Attr', 'LSize', 'Path']];
    for (const key of Object.keys(h.lvm.lvs).sort()) {
      const lv = h.lvm.lvs[key];
      rows.push([lv.name, lv.vg, h.active.lvActive[key] ? '-wi-a-----' : '-wi-------', human(lv.sizeMB), '/dev/' + key]);
    }
    ctx.out(table(rows));
    return 0;
  });

  // ---------------------------------------------------------------- filesystems and swap
  function mkfs(type) {
    return rootOnly(ctx => {
      const h = ctx.host;
      const a = parseArgs(ctx.args, '');
      const dev = a.pos[0];
      if (!dev) throw new Error('no device specified');
      const key = lvKey(h, dev);
      if (!key) throw new Error(dev + ': No such file or directory');
      const lv = h.lvm.lvs[key];
      if (mountsOfLv(h, key).length) throw new Error(dev + ' is mounted; will not make a filesystem here!');
      if (lv.fs && !(a.flags.f || a.flags.F)) throw new Error(dev + ' contains a ' + lv.fs + ' file system');
      lv.fs = type;
      lv.uuid = newUuid();
      if (!a.flags.q) ctx.out(type + ' filesystem created on ' + dev + ' (UUID=' + lv.uuid + ')\n');
      return 0;
    });
  }
  reg('mkfs.xfs', mkfs('xfs'));
  reg('mkfs.ext4', mkfs('ext4'));

  reg('mkswap', rootOnly(ctx => {
    const h = ctx.host;
    const dev = parseArgs(ctx.args, '').pos[0];
    if (!dev) throw new Error('no device specified');
    const key = lvKey(h, dev);
    if (!key) throw new Error(dev + ': No such file or directory');
    const lv = h.lvm.lvs[key];
    lv.fs = 'swap';
    lv.uuid = newUuid();
    ctx.out('Setting up swapspace version 1, size = ' + lv.sizeMB * 1024 + ' KiB\nno label, UUID=' + lv.uuid + '\n');
    return 0;
  }));

  const swapPath = (key) => '/dev/' + key;

  // Activate a swap LV. Throws the RHEL-style error when the device cannot be used.
  function swapOn(h, dev) {
    const key = lvKey(h, dev);
    if (!key) throw new Error(dev + ': No such file or directory');
    if (!h.active.lvActive[key]) throw new Error(dev + ': not an active logical volume');
    if (h.lvm.lvs[key].fs !== 'swap') throw new Error(dev + ': read swap header failed');
    if (h.active.swaps.indexOf(swapPath(key)) !== -1) throw new Error(dev + ': Device or resource busy');
    h.active.swaps.push(swapPath(key));
  }

  reg('swapon', rootOnly(ctx => {
    const h = ctx.host;
    const a = parseArgs(ctx.args, '');
    if (a.flags.a) {
      let code = 0;
      for (const e of Sim.parseFstab(h)) {
        if (e.fstype !== 'swap') continue;
        const key = lvKey(h, e.source);
        if (key && h.active.swaps.indexOf(swapPath(key)) !== -1) continue;
        try { swapOn(h, e.source); } catch (err) { ctx.err('swapon: ' + err.message + '\n'); code = 1; }
      }
      return code;
    }
    if (!a.pos[0]) throw new Error('usage: swapon [-a] DEVICE');
    swapOn(h, a.pos[0]);
    return 0;
  }));

  reg('swapoff', rootOnly(ctx => {
    const h = ctx.host;
    const dev = parseArgs(ctx.args, '').pos[0];
    if (!dev) throw new Error('usage: swapoff DEVICE');
    const key = lvKey(h, dev);
    const i = h.active.swaps.indexOf(key ? swapPath(key) : dev);
    if (i === -1) throw new Error(dev + ': not active');
    h.active.swaps.splice(i, 1);
    return 0;
  }));

  // ---------------------------------------------------------------- mounts
  function checkNfs(h, lab, source) {
    const i = source.indexOf(':');
    if (i < 1) throw new Error('mount.nfs: Invalid argument');
    const srv = lab.host(source.slice(0, i));
    if (!srv) throw new Error('mount.nfs: Connection timed out');
    const svc = srv.active && srv.active.services && srv.active.services['nfs-server'];
    if (!svc || !svc.active) throw new Error('mount.nfs: Connection refused');
    if (!Sim.exportAllows(srv, source.slice(i + 1), h.ip)) {
      throw new Error('mount.nfs: access denied by server while mounting ' + source);
    }
  }

  // Mount SOURCE on TARGET on host h. Throws RHEL-style errors. Shared by mount, mount -a and boot.
  function doMount(h, lab, source, target, fstype, opts) {
    if (!fs.exists(h, target)) throw new Error('mount point does not exist');
    if (!fs.isDir(h, target)) throw new Error('mount point is not a directory');
    if (h.active.mounts.some(m => m.target === target)) throw new Error(target + ' is already mounted');
    const type = fstype && fstype !== 'auto' ? fstype : null;
    if (type ? /^nfs/.test(type) : /^[^\/]+:\//.test(source)) {
      checkNfs(h, lab, source);
      h.active.mounts.push({ source: source, target: target, fstype: type || 'nfs', opts: opts });
      return;
    }
    const key = lvKey(h, source);
    const lv = key ? h.lvm.lvs[key] : null;
    if (!lv || !h.active.lvActive[key]) throw new Error("can't find " + source);
    if (!lv.fs || lv.fs === 'swap' || (type && type !== lv.fs)) {
      throw new Error('wrong fs type, bad option, bad superblock on ' + source);
    }
    h.active.mounts.push({ source: source, target: target, fstype: lv.fs, opts: opts });
  }

  // mount -a: every non-swap fstab entry that is not mounted yet (swap is handled by swapon -a).
  function mountAll(ctx) {
    const h = ctx.host;
    let code = 0;
    for (const e of Sim.parseFstab(h)) {
      if (e.fstype === 'swap' || h.active.mounts.some(m => m.target === e.target)) continue;
      try { doMount(h, ctx.lab, e.source, e.target, e.fstype, e.opts); }
      catch (err) { ctx.err('mount: ' + e.target + ': ' + err.message + '\n'); code = 32; }
    }
    return code;
  }

  reg('mount', ctx => {
    const h = ctx.host;
    if (!ctx.args.length) {
      for (const m of h.active.mounts) ctx.out(m.source + ' on ' + m.target + ' type ' + m.fstype + ' (' + m.opts + ')\n');
      return 0;
    }
    requireRoot(ctx);
    const a = parseArgs(ctx.args, 'to');
    if (a.flags.a) return mountAll(ctx);
    const source = a.pos[0];
    const target = a.pos[1];
    if (!source || !target) throw new Error('usage: mount [-t type] [-o options] SOURCE TARGET');
    doMount(h, ctx.lab, source, fs.abs(h, ctx.session, target), a.opts.t, a.opts.o || 'defaults');
    return 0;
  });

  reg('umount', rootOnly(ctx => {
    const h = ctx.host;
    const arg = parseArgs(ctx.args, '').pos[0];
    if (!arg) throw new Error('usage: umount TARGET|SOURCE');
    const target = fs.abs(h, ctx.session, arg);
    const i = h.active.mounts.findIndex(m => m.target === target || sameSource(h, m.source, arg));
    if (i === -1) throw new Error(arg + ': not mounted');
    h.active.mounts.splice(i, 1);
    return 0;
  }));

  reg('df', ctx => {
    const h = ctx.host;
    const hflag = parseArgs(ctx.args, '').flags.h;
    const fmt = mb => (hflag ? human(mb) : String(Math.round(mb * 1024)));
    const rows = [['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on']];
    for (const m of h.active.mounts) {
      let size, used;
      const key = lvKey(h, m.source);
      if (key) {
        size = h.lvm.lvs[key].sizeMB;
        used = Math.min(size, Math.ceil(size * FS_OVERHEAD + bytesUnder(h, m.target) / MB));
      } else {
        // NFS: fixed 1G size, usage read from the export directory on the server.
        const i = m.source.indexOf(':');
        const srv = i > 0 ? ctx.lab.host(m.source.slice(0, i)) : null;
        size = 1024;
        used = srv ? Math.min(size, Math.ceil(bytesUnder(srv, m.source.slice(i + 1)) / MB)) : 0;
      }
      rows.push([m.source, fmt(size), fmt(used), fmt(size - used), Math.round(used / size * 100) + '%', m.target]);
    }
    ctx.out(table(rows));
    return 0;
  });

  // ---------------------------------------------------------------- block device listings
  // LVs of a VG are shown under the first PV of that VG.
  function lvsOnDisk(h, dev) {
    const out = [];
    for (const vgName of Object.keys(h.lvm.vgs)) {
      if (h.lvm.vgs[vgName].pvs[0] !== dev) continue;
      for (const key of Object.keys(h.lvm.lvs)) if (h.lvm.lvs[key].vg === vgName) out.push(key);
    }
    return out;
  }

  reg('lsblk', ctx => {
    const h = ctx.host;
    const rows = [['NAME', 'SIZE', 'LABEL', 'TYPE', 'FSTYPE', 'MOUNTPOINT']];
    for (const dev of Object.keys(h.disks).sort()) {
      const d = h.disks[dev];
      rows.push([dev.slice(5), human(d.sizeMB), d.label, 'disk', own(h.lvm.pvs, dev) ? 'LVM2_member' : '', '']);
      const kids = lvsOnDisk(h, dev);
      kids.forEach((key, i) => {
        const lv = h.lvm.lvs[key];
        const branch = i === kids.length - 1 ? '└─' : '├─';
        const mounts = mountsOfLv(h, key).map(m => m.target).join(',');
        rows.push([branch + lv.vg + '-' + lv.name, human(lv.sizeMB), '', 'lvm', lv.fs || '', mounts]);
      });
    }
    ctx.out(table(rows));
    return 0;
  });

  reg('blkid', ctx => {
    const h = ctx.host;
    for (const key of Object.keys(h.lvm.lvs)) {
      const lv = h.lvm.lvs[key];
      if (lv.fs) ctx.out('/dev/' + key + ': UUID="' + lv.uuid + '" TYPE="' + lv.fs + '"\n');
    }
    return 0;
  });

  // ---------------------------------------------------------------- boot
  // Phase 1: LVM activates every LV at boot.
  Sim.bootStep(1, function (h) {
    for (const key of Object.keys(h.lvm.lvs)) h.active.lvActive[key] = true;
  });

  // Phase 2: fstab. Each entry is independent; failures go to bootErrors and boot continues.
  Sim.bootStep(2, function (h, lab) {
    for (const e of Sim.parseFstab(h)) {
      try {
        if (e.fstype === 'swap') swapOn(h, e.source);
        else doMount(h, lab, e.source, e.target, e.fstype, e.opts);
      } catch (err) {
        h.active.bootErrors.push('fstab ' + e.source + ' on ' + e.target + ': ' + err.message);
      }
    }
  });
})();
