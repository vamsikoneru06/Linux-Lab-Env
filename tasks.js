/*
 * RHLab exam tasks (16, in exam order). Plain browser JS; requires core.js (window.Sim).
 * Every check is read-only: it inspects Sim.fs and host state and never writes.
 * Each check returns {pass, reason}; an exception is reported as a failure.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- read-only helpers
  const ok = (reason) => ({ pass: true, reason: 'ok: ' + reason });
  const bad = (reason) => ({ pass: false, reason: reason });
  const lines = (h, p) => Sim.fileLines(h, p);
  const fstab = (h) => Sim.parseFstab(h);
  const mounts = (h) => (h.active && h.active.mounts) || [];
  const lvm = (h) => h.lvm || { pvs: {}, vgs: {}, lvs: {} };
  const listDir = (h, p) => { try { return Sim.fs.list(h, p); } catch (e) { return []; } };
  const hasOpt = (opts, o) => String(opts).split(',').indexOf(o) !== -1;
  const octal = (m) => '0' + (m & 0o777).toString(8);
  const members = (g) => (g && g.members) || [];

  // LV device name: '/dev/VG/LV' or '/dev/mapper/VG-LV'.
  const isLvDev = (src, vg, lv) =>
    src === '/dev/' + vg + '/' + lv || src === '/dev/mapper/' + vg + '-' + lv;

  function mountedLv(h, target, vg, lv) {
    const m = mounts(h).find(x => x.target === target);
    if (!m) return bad(target + ' not mounted');
    if (!isLvDev(m.source, vg, lv)) return bad(target + ' mounted from ' + m.source + ', expected /dev/' + vg + '/' + lv);
    return ok(target + ' mounted from /dev/' + vg + '/' + lv);
  }

  function fstabLv(h, vg, lv, target, fstype) {
    const e = fstab(h).find(x => isLvDev(x.source, vg, lv) && x.target === target);
    if (!e) return bad('fstab entry for /dev/' + vg + '/' + lv + ' on ' + target + ' missing');
    if (e.fstype !== fstype) return bad('fstab type for ' + target + ' is ' + e.fstype + ', expected ' + fstype);
    return ok('fstab has /dev/' + vg + '/' + lv + ' on ' + target + ' (' + fstype + ')');
  }

  // NFS export helpers. The required export options for tasks 6 and 8.
  const WANT_OPTS = ['rw', 'sync', 'no_root_squash'];
  const exportsFor = (h, path) => Sim.parseExports(h).filter(e => e.path === path);
  const exportLineOk = (h, path) => exportsFor(h, path).some(e => e.clients.some(c =>
    c.spec === '192.168.50.0/24' && WANT_OPTS.every(o => hasOpt(c.opts, o))));
  const exportApplied = (h, path) =>
    ((h.active && h.active.exportsApplied) || []).some(e => e.path === path);

  // Service helpers.
  const unitEnabled = (h, unit) => !!(h.units && h.units[unit] && h.units[unit].enabled);
  const svcActive = (h, unit) => !!(h.active && h.active.services && h.active.services[unit] && h.active.services[unit].active);
  function svcOk(h, unit) {
    if (!unitEnabled(h, unit)) return bad(unit + ' is not enabled');
    if (!svcActive(h, unit)) return bad(unit + ' is not running');
    return ok(unit + ' enabled and running');
  }

  // /etc/auto.master.d/*: the map file given for a key ('/rhome' or '/-'), or null.
  function autoMasterMap(h, key) {
    for (const f of listDir(h, '/etc/auto.master.d')) {
      for (const l of lines(h, '/etc/auto.master.d/' + f)) {
        const m = l.match(/^(\S+)\s+(\S+)/);
        if (m && m[1] === key) return m[2];
      }
    }
    return null;
  }

  // Map file for an indirect mount, with an existence check. Returns {map} or {fail}.
  function indirectMapOrFail(h, mount) {
    const map = autoMasterMap(h, mount);
    if (!map) return { fail: bad('no /etc/auto.master.d entry for ' + mount) };
    if (!Sim.fs.isFile(h, map)) return { fail: bad('map file ' + map + ' not found') };
    return { map: map };
  }

  // The sudoers.d file that grants sysadmins NOPASSWD: ALL, or null.
  const SUDO_RULE = /^%sysadmins\s+ALL=\(ALL\)\s+NOPASSWD:\s*ALL/;
  function sudoRuleFile(h) {
    return listDir(h, '/etc/sudoers.d').map(f => '/etc/sudoers.d/' + f)
      .find(f => lines(h, f).some(l => SUDO_RULE.test(l))) || null;
  }

  // Map-line patterns for the /rhome map (tasks 8 and 10).
  const REMOTEUSER1_LINE = /^remoteuser1\s+(\S+\s+)?server:\/rhome\/remoteuser1$/;
  const WILDCARD_LINE = /^\*\s+(\S+\s+)?server:\/rhome\/&$/;
  const DOCS_LINE = /^\/mnt\/docs\s+-ro\s+server:\/share\/docs$/;

  // A check bound to one host ('server' or 'client'). Exceptions become failures.
  function chk(id, host, desc, fn) {
    return {
      id: id,
      desc: desc,
      run: function (lab) {
        try { return fn(lab.hosts[host], lab); }
        catch (e) { return bad('error: ' + e.message); }
      },
    };
  }

  // ---------------------------------------------------------------- tasks
  const tasks = [
    // 1
    {
      id: 'lvm-1', num: 1, topic: 'LVM', host: 'client', title: 'Create datavg and mount datalv on /data',
      prereqs: [],
      scenario: 'On client, use /dev/loop0 (disk1) to create a volume group named datavg with a physical extent size of 16 MiB. Create a logical volume named datalv of 30 extents in datavg, format it with XFS, and mount it persistently on /data.',
      hint: 'Work from the physical volume up to the volume group, the logical volume, the file system, then the fstab entry. Mount it so it works without a reboot.',
      solution: [
        'client: pvcreate /dev/loop0',
        'client: vgcreate -s 16M datavg /dev/loop0',
        'client: lvcreate -l 30 -n datalv datavg',
        'client: mkfs.xfs /dev/datavg/datalv',
        "client: echo '/dev/datavg/datalv /data xfs defaults 0 0' >> /etc/fstab",
        'client: mount -a',
      ],
      checks: [
        chk('lvm-1-vg', 'client', 'VG datavg with PE 16M and /dev/loop0', (h) => {
          const vg = lvm(h).vgs.datavg;
          if (!vg) return bad('VG datavg not found');
          if (vg.peMB !== 16) return bad('VG datavg PE size is ' + vg.peMB + 'M, expected 16M');
          const pv = lvm(h).pvs['/dev/loop0'];
          if (!pv || pv.vg !== 'datavg') return bad('/dev/loop0 is not a PV in datavg');
          return ok('VG datavg PE 16M on /dev/loop0');
        }),
        chk('lvm-1-lv', 'client', 'LV datavg/datalv formatted xfs', (h) => {
          const lv = lvm(h).lvs['datavg/datalv'];
          if (!lv) return bad('LV datalv not found in datavg');
          if (lv.fs !== 'xfs') return bad('LV datalv fs is ' + (lv.fs || 'none') + ', expected xfs');
          return ok('LV datavg/datalv is xfs');
        }),
        chk('lvm-1-fstab', 'client', 'fstab mounts datalv on /data as xfs', (h) =>
          fstabLv(h, 'datavg', 'datalv', '/data', 'xfs')),
        chk('lvm-1-mount', 'client', '/data mounted from datalv', (h) =>
          mountedLv(h, '/data', 'datavg', 'datalv')),
      ],
    },

    // 2
    {
      id: 'lvm-2', num: 2, topic: 'LVM', host: 'client', title: 'Extend datalv to 800M, keep data',
      prereqs: ['lvm-1'],
      scenario: 'On client, first create the file /data/testfile.txt containing the text exam data. Then extend the logical volume datalv to 800 MiB, growing the file system with it, so that the file and the mount remain intact.',
      hint: 'The LV extend command can resize the file system in the same step. Write the test file before you resize.',
      solution: [
        "client: echo 'exam data' > /data/testfile.txt",
        'client: lvextend -r -L 800M datavg/datalv',
      ],
      checks: [
        chk('lvm-2-size', 'client', 'datalv is 800M', (h) => {
          const lv = lvm(h).lvs['datavg/datalv'];
          if (!lv) return bad('LV datalv not found');
          return lv.sizeMB === 800 ? ok('LV datavg/datalv is 800M') : bad('LV size is ' + lv.sizeMB + ' M, expected 800M');
        }),
        chk('lvm-2-data', 'client', '/data/testfile.txt contains exam data', (h) => {
          if (!Sim.fs.isFile(h, '/data/testfile.txt')) return bad('/data/testfile.txt not found');
          const t = Sim.fs.read(h, '/data/testfile.txt');
          return t.indexOf('exam data') !== -1 ? ok('/data/testfile.txt contains exam data')
            : bad('/data/testfile.txt does not contain "exam data"');
        }),
        chk('lvm-2-mount', 'client', '/data still mounted from datalv', (h) =>
          mountedLv(h, '/data', 'datavg', 'datalv')),
      ],
    },

    // 3
    {
      id: 'lvm-3', num: 3, topic: 'LVM', host: 'client', title: 'Add disk2 to datavg',
      prereqs: ['lvm-1'],
      scenario: 'On client, add the second disk /dev/loop1 (disk2) to the existing volume group datavg so the group has more free space. Leave datalv unchanged.',
      hint: 'A disk must be initialised as a physical volume before it can join a volume group.',
      solution: [
        'client: pvcreate /dev/loop1',
        'client: vgextend datavg /dev/loop1',
      ],
      checks: [
        chk('lvm-3-pv', 'client', '/dev/loop1 is a PV in datavg', (h) => {
          const pv = lvm(h).pvs['/dev/loop1'];
          if (!pv) return bad('/dev/loop1 is not a physical volume');
          if (pv.vg !== 'datavg') return bad('/dev/loop1 is not in datavg (vg: ' + (pv.vg || 'none') + ')');
          return ok('/dev/loop1 is a PV in datavg');
        }),
      ],
    },

    // 4
    {
      id: 'lvm-4', num: 4, topic: 'LVM', host: 'client', title: 'Persistent 512M swap LV',
      prereqs: ['lvm-3'],
      scenario: 'On client, create a 512 MiB logical volume named swaplv in datavg and set it up as swap space. It must be activated persistently so that it is used as swap at every boot.',
      hint: 'Create the LV, write a swap signature to it, add a swap entry to fstab, then enable all swap entries.',
      solution: [
        'client: lvcreate -L 512M -n swaplv datavg',
        'client: mkswap /dev/datavg/swaplv',
        "client: echo '/dev/datavg/swaplv swap swap defaults 0 0' >> /etc/fstab",
        'client: swapon -a',
      ],
      checks: [
        chk('lvm-4-lv', 'client', 'LV datavg/swaplv is 512M swap', (h) => {
          const lv = lvm(h).lvs['datavg/swaplv'];
          if (!lv) return bad('LV swaplv not found in datavg');
          if (lv.sizeMB !== 512) return bad('LV size is ' + lv.sizeMB + ' M, expected 512M');
          if (lv.fs !== 'swap') return bad('LV swaplv fs is ' + (lv.fs || 'none') + ', expected swap');
          return ok('LV datavg/swaplv is 512M swap');
        }),
        chk('lvm-4-fstab', 'client', 'fstab has swap entry for swaplv', (h) =>
          fstab(h).some(e => isLvDev(e.source, 'datavg', 'swaplv') && e.fstype === 'swap')
            ? ok('fstab has swap entry for /dev/datavg/swaplv')
            : bad('fstab swap entry for /dev/datavg/swaplv missing')),
        chk('lvm-4-active', 'client', 'swaplv active as swap', (h) => {
          const s = (h.active && h.active.swaps) || [];
          return s.some(d => isLvDev(d, 'datavg', 'swaplv'))
            ? ok('/dev/datavg/swaplv active as swap')
            : bad('/dev/datavg/swaplv is not active as swap');
        }),
      ],
    },

    // 5
    {
      id: 'lvm-5', num: 5, topic: 'LVM', host: 'client', title: 'Shrink ext4 backuplv to 500M',
      prereqs: [],
      scenario: 'On client, use /dev/loop2 (disk3) to create a volume group named backupvg with the default physical extent size. Create a 1 GiB logical volume named backuplv in backupvg, format it with ext4, and mount it persistently on /backup. Copy /etc/hosts into /backup, then shrink backuplv to 500 MiB without losing the copied file.',
      hint: 'ext4 must be unmounted before it can shrink, so remount it afterwards. Use the LV reduce command with its option that also resizes the file system.',
      solution: [
        'client: pvcreate /dev/loop2',
        'client: vgcreate backupvg /dev/loop2',
        'client: lvcreate -L 1G -n backuplv backupvg',
        'client: mkfs.ext4 /dev/backupvg/backuplv',
        "client: echo '/dev/backupvg/backuplv /backup ext4 defaults 0 0' >> /etc/fstab",
        'client: mount -a',
        'client: cp /etc/hosts /backup/',
        'client: umount /backup',
        'client: lvreduce -r -L 500M backupvg/backuplv',
        'client: mount -a',
      ],
      checks: [
        chk('lvm-5-pv', 'client', 'backupvg has /dev/loop2 as PV', (h) => {
          const pv = lvm(h).pvs['/dev/loop2'];
          if (!pv || pv.vg !== 'backupvg') return bad('/dev/loop2 is not a PV in backupvg');
          return ok('/dev/loop2 is a PV in backupvg');
        }),
        chk('lvm-5-lv', 'client', 'backuplv is 500M ext4', (h) => {
          const lv = lvm(h).lvs['backupvg/backuplv'];
          if (!lv) return bad('LV backuplv not found in backupvg');
          if (lv.sizeMB !== 500) return bad('LV size is ' + lv.sizeMB + ' M, expected 500M');
          if (lv.fs !== 'ext4') return bad('LV backuplv fs is ' + (lv.fs || 'none') + ', expected ext4');
          return ok('LV backupvg/backuplv is 500M ext4');
        }),
        chk('lvm-5-fstab', 'client', 'fstab mounts backuplv on /backup as ext4', (h) =>
          fstabLv(h, 'backupvg', 'backuplv', '/backup', 'ext4')),
        chk('lvm-5-mount', 'client', '/backup mounted from backuplv', (h) =>
          mountedLv(h, '/backup', 'backupvg', 'backuplv')),
        chk('lvm-5-copy', 'client', '/backup/hosts exists', (h) =>
          Sim.fs.isFile(h, '/backup/hosts') ? ok('/backup/hosts exists') : bad('/backup/hosts not found')),
      ],
    },

    // 6
    {
      id: 'nfs-6', num: 6, topic: 'NFS', host: 'server', title: 'Export /share over NFS',
      prereqs: [],
      scenario: 'On server, export the directory /share to the 192.168.50.0/24 network with the rw, sync and no_root_squash options. The export must be applied, and the NFS server service must be enabled to start at boot and running now.',
      hint: 'Add the export line to the exports file, apply the export table, then enable and start the nfs-server unit in one step.',
      solution: [
        "server: echo '/share 192.168.50.0/24(rw,sync,no_root_squash)' >> /etc/exports",
        'server: exportfs -ra',
        'server: systemctl enable --now nfs-server',
      ],
      checks: [
        chk('nfs-6-export', 'server', '/share exported to 192.168.50.0/24 rw,sync,no_root_squash', (h) => {
          if (!exportsFor(h, '/share').length) return bad('/share not in /etc/exports');
          return exportLineOk(h, '/share')
            ? ok('/etc/exports exports /share to 192.168.50.0/24 (rw,sync,no_root_squash)')
            : bad('/share export to 192.168.50.0/24 lacks rw,sync,no_root_squash');
        }),
        chk('nfs-6-applied', 'server', '/share export applied', (h) =>
          exportApplied(h, '/share') ? ok('/share export applied') : bad('/share export not applied (run exportfs -ra)')),
        chk('nfs-6-service', 'server', 'nfs-server enabled and running', (h) => svcOk(h, 'nfs-server')),
      ],
    },

    // 7
    {
      id: 'nfs-7', num: 7, topic: 'NFS', host: 'client', title: 'Persistent NFS mount on /mnt/nfs',
      prereqs: ['nfs-6'],
      scenario: 'On client, mount the NFS export server:/share on the directory /mnt/nfs, and make the mount persistent across reboots. The entry must use the _netdev option so the mount waits for the network.',
      hint: 'Use the nfs file system type in fstab with the _netdev option, then mount everything listed in fstab.',
      solution: [
        "client: echo 'server:/share /mnt/nfs nfs defaults,_netdev 0 0' >> /etc/fstab",
        'client: mount -a',
      ],
      checks: [
        chk('nfs-7-fstab', 'client', 'fstab has server:/share on /mnt/nfs with _netdev', (h) => {
          const e = fstab(h).find(x => x.source === 'server:/share' && x.target === '/mnt/nfs' && x.fstype === 'nfs');
          if (!e) return bad('fstab entry server:/share on /mnt/nfs (nfs) missing');
          if (!hasOpt(e.opts, '_netdev')) return bad('fstab entry for /mnt/nfs lacks _netdev');
          return ok('fstab has server:/share on /mnt/nfs with _netdev');
        }),
        chk('nfs-7-mount', 'client', '/mnt/nfs mounted from server:/share', (h) => {
          const m = mounts(h).find(x => x.target === '/mnt/nfs');
          if (!m) return bad('/mnt/nfs not mounted');
          if (m.source !== 'server:/share') return bad('/mnt/nfs mounted from ' + m.source + ', expected server:/share');
          return ok('/mnt/nfs mounted from server:/share');
        }),
      ],
    },

    // 8
    {
      id: 'autofs-8', num: 8, topic: 'AutoFS', host: 'client', title: 'Indirect AutoFS map for remoteuser1',
      prereqs: ['nfs-6'],
      scenario: 'On server, create user remoteuser1 with UID 3001 and home directory /rhome/remoteuser1, and export /rhome to 192.168.50.0/24 with rw, sync and no_root_squash. On client, create user remoteuser1 with the same UID 3001 and home /rhome/remoteuser1, but without creating a local home directory. Configure AutoFS with an indirect map in /etc/auto.master.d/ so that /rhome/remoteuser1 is mounted automatically from server:/rhome/remoteuser1 when it is accessed, and make autofs start at boot.',
      hint: 'The client needs a master map file in auto.master.d that points at a map file. The map file gives the key and the NFS location. Enable the autofs unit.',
      solution: [
        'server: useradd -u 3001 -d /rhome/remoteuser1 remoteuser1',
        "server: echo '/rhome 192.168.50.0/24(rw,sync,no_root_squash)' >> /etc/exports",
        'server: exportfs -ra',
        'client: useradd -M -u 3001 -d /rhome/remoteuser1 remoteuser1',
        "client: echo '/rhome /etc/auto.rhome' > /etc/auto.master.d/rhome.autofs",
        "client: echo 'remoteuser1 -rw,sync server:/rhome/remoteuser1' > /etc/auto.rhome",
        'client: systemctl enable --now autofs',
        'client: ls /rhome/remoteuser1',
      ],
      checks: [
        chk('autofs-8-srv-user', 'server', 'server user remoteuser1 uid 3001, home /rhome/remoteuser1', (h) => {
          const u = Sim.findUser(h, 'remoteuser1');
          if (!u) return bad('user remoteuser1 not found on server');
          if (u.uid !== 3001) return bad('server remoteuser1 uid is ' + u.uid + ', expected 3001');
          if (u.home !== '/rhome/remoteuser1') return bad('server remoteuser1 home is ' + u.home + ', expected /rhome/remoteuser1');
          return ok('server user remoteuser1 uid 3001');
        }),
        chk('autofs-8-srv-export', 'server', '/rhome exported and applied', (h) => {
          if (!exportsFor(h, '/rhome').length) return bad('/rhome not in /etc/exports');
          if (!exportLineOk(h, '/rhome')) return bad('/rhome export lacks 192.168.50.0/24 rw,sync,no_root_squash');
          if (!exportApplied(h, '/rhome')) return bad('/rhome export not applied (run exportfs -ra)');
          return ok('/rhome exported and applied');
        }),
        chk('autofs-8-cli-user', 'client', 'client user remoteuser1 uid 3001', (h) => {
          const u = Sim.findUser(h, 'remoteuser1');
          if (!u) return bad('user remoteuser1 not found on client');
          if (u.uid !== 3001) return bad('client remoteuser1 uid is ' + u.uid + ', expected 3001');
          return ok('client user remoteuser1 uid 3001');
        }),
        chk('autofs-8-map', 'client', '/rhome indirect map serves remoteuser1', (h) => {
          const r = indirectMapOrFail(h, '/rhome');
          if (r.fail) return r.fail;
          // Task 10 turns the specific line into a wildcard, so either form satisfies this task.
          const served = lines(h, r.map).some(l => REMOTEUSER1_LINE.test(l) || WILDCARD_LINE.test(l));
          return served ? ok('/rhome map ' + r.map + ' serves remoteuser1')
            : bad(r.map + ' has no line for remoteuser1 from server:/rhome/remoteuser1');
        }),
        chk('autofs-8-service', 'client', 'autofs enabled and running', (h) => svcOk(h, 'autofs')),
      ],
    },

    // 9
    {
      id: 'autofs-9', num: 9, topic: 'AutoFS', host: 'client', title: 'Direct AutoFS map for /mnt/docs',
      prereqs: ['autofs-8', 'nfs-6'],
      scenario: 'On client, configure a direct AutoFS map through /etc/auto.master.d/ so that the NFS export server:/share/docs is mounted read-only on /mnt/docs when that directory is accessed.',
      hint: 'A direct map uses the /- mount point in the master file, and its map file gives the full path for each key. Restart autofs after changing the maps.',
      solution: [
        "client: echo '/- /etc/auto.docs' > /etc/auto.master.d/docs.autofs",
        "client: echo '/mnt/docs -ro server:/share/docs' > /etc/auto.docs",
        'client: systemctl restart autofs',
        'client: ls /mnt/docs',
      ],
      checks: [
        chk('autofs-9-map', 'client', 'direct map mounts server:/share/docs ro on /mnt/docs', (h) => {
          const map = autoMasterMap(h, '/-');
          if (!map) return bad('no direct map (/- line) in /etc/auto.master.d/');
          if (!Sim.fs.isFile(h, map)) return bad('direct map file ' + map + ' not found');
          return lines(h, map).some(l => DOCS_LINE.test(l))
            ? ok('direct map ' + map + ' mounts /mnt/docs')
            : bad(map + ' has no line "/mnt/docs -ro server:/share/docs"');
        }),
        chk('autofs-9-service', 'client', 'autofs enabled and running', (h) => svcOk(h, 'autofs')),
      ],
    },

    // 10
    {
      id: 'autofs-10', num: 10, topic: 'AutoFS', host: 'client', title: 'Wildcard AutoFS map for /rhome',
      prereqs: ['autofs-8'],
      scenario: 'On client, change the /rhome indirect map into a wildcard map. Any user home directory under /rhome must be mounted automatically from server:/rhome/<username>, and the map must no longer contain an entry specific to remoteuser1. Restart autofs to apply the change.',
      hint: 'A wildcard key matches any name, and an ampersand in the location is replaced by the name that matched.',
      solution: [
        "client: echo '* -rw,sync server:/rhome/&' > /etc/auto.rhome",
        'client: systemctl restart autofs',
      ],
      checks: [
        chk('autofs-10-wildcard', 'client', '/rhome map is "* ... server:/rhome/&" with no remoteuser1 line', (h) => {
          const r = indirectMapOrFail(h, '/rhome');
          if (r.fail) return r.fail;
          const ls = lines(h, r.map);
          if (!ls.some(l => WILDCARD_LINE.test(l))) return bad(r.map + ' has no wildcard "* ... server:/rhome/&" line');
          if (ls.some(l => /^remoteuser1\s/.test(l))) return bad(r.map + ' still has a specific remoteuser1 line');
          return ok(r.map + ' is a wildcard map for server:/rhome/&');
        }),
        chk('autofs-10-service', 'client', 'autofs enabled and running', (h) => svcOk(h, 'autofs')),
      ],
    },

    // 11
    {
      id: 'users-11', num: 11, topic: 'Users', host: 'client', title: 'Create harry with sysadmins group',
      prereqs: [],
      scenario: 'On client, create a group named sysadmins. Create user harry with UID 2001 and make sysadmins his secondary group. Set the password of harry to redhat.',
      hint: 'useradd has an option for supplementary groups. Set the password non-interactively by passing it on standard input.',
      solution: [
        'client: groupadd sysadmins',
        'client: useradd -u 2001 -G sysadmins harry',
        'client: echo redhat | passwd --stdin harry',
      ],
      checks: [
        chk('users-11-uid', 'client', 'user harry uid 2001', (h) => {
          const u = Sim.findUser(h, 'harry');
          if (!u) return bad('user harry not found');
          return u.uid === 2001 ? ok('user harry uid 2001') : bad('harry uid is ' + u.uid + ', expected 2001');
        }),
        chk('users-11-group', 'client', 'harry is a member of sysadmins', (h) => {
          if (!h.groups.sysadmins) return bad('group sysadmins not found');
          return members(h.groups.sysadmins).indexOf('harry') !== -1
            ? ok('harry is in sysadmins')
            : bad('harry is not a member of sysadmins');
        }),
        chk('users-11-password', 'client', 'harry password is redhat', (h) => {
          const u = h.users.harry;
          if (!u) return bad('user harry not found');
          return u.pw === 'redhat' ? ok('harry password is set') : bad('harry password is not redhat');
        }),
      ],
    },

    // 12
    {
      id: 'users-12', num: 12, topic: 'Users', host: 'client', title: 'Create sarah with nologin shell',
      prereqs: ['users-11'],
      scenario: 'On client, create user sarah with /sbin/nologin as her login shell. Sarah must not be a member of the sysadmins group.',
      hint: 'useradd has an option for the login shell. Do not add sarah to any supplementary group.',
      solution: [
        'client: useradd -s /sbin/nologin sarah',
      ],
      checks: [
        chk('users-12-shell', 'client', 'sarah has /sbin/nologin shell', (h) => {
          const u = Sim.findUser(h, 'sarah');
          if (!u) return bad('user sarah not found');
          return u.shell === '/sbin/nologin' ? ok('sarah shell is /sbin/nologin')
            : bad('sarah shell is ' + u.shell + ', expected /sbin/nologin');
        }),
        chk('users-12-group', 'client', 'sarah is not in sysadmins', (h) => {
          if (!Sim.findUser(h, 'sarah')) return bad('user sarah not found');
          return members(h.groups.sysadmins).indexOf('sarah') !== -1
            ? bad('sarah is a member of sysadmins')
            : ok('sarah is not in sysadmins');
        }),
      ],
    },

    // 13
    {
      id: 'users-13', num: 13, topic: 'Users', host: 'client', title: 'Password and account aging policy',
      prereqs: ['users-11', 'users-12'],
      scenario: 'On client, apply these rules. The password of harry must expire every 90 days (maximum age 90). User natasha must change her password at her first login; create natasha with password redhat if she does not exist. The account sarah must expire on 2026-12-31. Every new user must get a default maximum password age of 60 days, set in /etc/login.defs.',
      hint: 'chage manages password aging and account expiry for an existing user. The defaults for new accounts are in /etc/login.defs.',
      solution: [
        'client: chage -M 90 harry',
        'client: useradd natasha',
        'client: echo redhat | passwd --stdin natasha',
        'client: chage -d 0 natasha',
        'client: chage -E 2026-12-31 sarah',
        "client: sed -i 's/^PASS_MAX_DAYS.*/PASS_MAX_DAYS 60/' /etc/login.defs",
      ],
      checks: [
        chk('users-13-harry', 'client', 'harry maxDays 90', (h) => {
          const u = Sim.findUser(h, 'harry');
          if (!u) return bad('user harry not found');
          return u.maxDays === 90 ? ok('harry maximum password age is 90')
            : bad('harry maxDays is ' + u.maxDays + ', expected 90');
        }),
        chk('users-13-natasha', 'client', 'natasha must change password at first login', (h) => {
          const u = Sim.findUser(h, 'natasha');
          if (!u) return bad('user natasha not found');
          return u.mustChange === true ? ok('natasha must change password at first login')
            : bad('natasha is not required to change her password at first login');
        }),
        chk('users-13-sarah', 'client', 'sarah account expires 2026-12-31', (h) => {
          const u = Sim.findUser(h, 'sarah');
          if (!u) return bad('user sarah not found');
          return u.expire === '2026-12-31' ? ok('sarah expires 2026-12-31')
            : bad('sarah expire is ' + (u.expire || 'never') + ', expected 2026-12-31');
        }),
        chk('users-13-defaults', 'client', '/etc/login.defs PASS_MAX_DAYS 60', (h) =>
          lines(h, '/etc/login.defs').some(l => /^PASS_MAX_DAYS\s+60$/.test(l))
            ? ok('PASS_MAX_DAYS 60 in /etc/login.defs')
            : bad('/etc/login.defs PASS_MAX_DAYS is not 60')),
      ],
    },

    // 14
    {
      id: 'users-14', num: 14, topic: 'Users', host: 'client', title: 'Passwordless sudo for sysadmins',
      prereqs: ['users-11'],
      scenario: 'On client, give members of the sysadmins group full sudo rights without a password prompt. Put the rule in its own file in /etc/sudoers.d, give that file mode 0440, and make sure the sudo configuration passes the visudo syntax check.',
      hint: 'sudo reads the files in /etc/sudoers.d. A group name in a sudoers rule is written with a leading percent sign.',
      solution: [
        "client: echo '%sysadmins ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/sysadmins",
        'client: chmod 0440 /etc/sudoers.d/sysadmins',
        'client: visudo -c',
      ],
      checks: [
        chk('users-14-rule', 'client', 'sudoers.d grants sysadmins NOPASSWD: ALL', (h) => {
          const f = sudoRuleFile(h);
          return f ? ok(f + ' grants sysadmins NOPASSWD: ALL')
            : bad('no file in /etc/sudoers.d grants %sysadmins NOPASSWD: ALL');
        }),
        chk('users-14-mode', 'client', 'sudoers file mode 0440', (h) => {
          const f = sudoRuleFile(h);
          if (!f) return bad('no file in /etc/sudoers.d grants %sysadmins NOPASSWD: ALL');
          const n = Sim.fs.get(h, f);
          return (n.mode & 0o777) === 0o440 ? ok(f + ' mode is 0440')
            : bad(f + ' mode is ' + octal(n.mode) + ', expected 0440');
        }),
      ],
    },

    // 15
    {
      id: 'groups-15', num: 15, topic: 'Groups', host: 'client', title: 'Group devops with GID 4000',
      prereqs: ['users-11', 'users-13'],
      scenario: 'On client, create a group named devops with GID 4000. Add harry and natasha to devops, then remove natasha from it, so that only harry is a member.',
      hint: 'gpasswd can add a user to an existing group and remove a user from it.',
      solution: [
        'client: groupadd -g 4000 devops',
        'client: gpasswd -a harry devops',
        'client: gpasswd -a natasha devops',
        'client: gpasswd -d natasha devops',
      ],
      checks: [
        chk('groups-15-gid', 'client', 'group devops GID 4000', (h) => {
          const g = h.groups.devops;
          if (!g) return bad('group devops not found');
          return g.gid === 4000 ? ok('group devops GID 4000') : bad('devops GID is ' + g.gid + ', expected 4000');
        }),
        chk('groups-15-harry', 'client', 'harry is a member of devops', (h) => {
          if (!h.groups.devops) return bad('group devops not found');
          return members(h.groups.devops).indexOf('harry') !== -1
            ? ok('harry is in devops') : bad('harry is not a member of devops');
        }),
        chk('groups-15-natasha', 'client', 'natasha is not a member of devops', (h) => {
          if (!h.groups.devops) return bad('group devops not found');
          return members(h.groups.devops).indexOf('natasha') === -1
            ? ok('natasha is not in devops') : bad('natasha is still a member of devops');
        }),
      ],
    },

    // 16
    {
      id: 'groups-16', num: 16, topic: 'Groups', host: 'client', title: 'Shared /common directory',
      prereqs: ['users-11'],
      scenario: 'On client, create a shared directory /common owned by the group sysadmins. Members of sysadmins get full access and everyone else gets no access. New files and subdirectories created inside /common must automatically belong to the sysadmins group, and users must not be able to delete each other\'s files.',
      hint: 'Three things are needed: the group owner, the setgid bit so new files inherit the group, and the sticky bit. All of them can be set in one octal mode.',
      solution: [
        'client: mkdir -p /common',
        'client: chgrp sysadmins /common',
        'client: chmod 3770 /common',
      ],
      checks: [
        // core seeds /common as a plain directory, so the directory test is folded into the owner check
        // (otherwise it would pass on a fresh lab).
        chk('groups-16-group', 'client', '/common is a directory owned by group sysadmins', (h) => {
          const g = h.groups.sysadmins;
          if (!g) return bad('group sysadmins not found');
          if (!Sim.fs.isDir(h, '/common')) return bad('/common directory not found');
          const n = Sim.fs.get(h, '/common');
          return n.gid === g.gid ? ok('/common is a directory owned by sysadmins')
            : bad('/common group gid is ' + n.gid + ', expected sysadmins (gid ' + g.gid + ')');
        }),
        chk('groups-16-mode', 'client', '/common mode rwxrwx---', (h) => {
          const n = Sim.fs.get(h, '/common');
          if (!n) return bad('/common not found');
          return (n.mode & 0o777) === 0o770 ? ok('/common permissions are 0770')
            : bad('/common permissions are ' + octal(n.mode) + ', expected 0770');
        }),
        chk('groups-16-setgid', 'client', 'setgid bit set on /common', (h) => {
          const n = Sim.fs.get(h, '/common');
          if (!n) return bad('/common not found');
          return (n.mode & 0o2000) ? ok('setgid bit set on /common') : bad('setgid bit not set on /common');
        }),
        chk('groups-16-sticky', 'client', 'sticky bit set on /common', (h) => {
          const n = Sim.fs.get(h, '/common');
          if (!n) return bad('/common not found');
          return (n.mode & 0o1000) ? ok('sticky bit set on /common') : bad('sticky bit not set on /common');
        }),
      ],
    },
  ];

  window.LAB_TASKS = tasks;
})();
