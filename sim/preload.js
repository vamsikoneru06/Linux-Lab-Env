/*
 * Built-in examples. Every new lab (first visit, Reset lab, mock exam) starts with three
 * extra 2G disks per host (/dev/loop3-5) and some ready-made volumes, so there is something
 * to look at and try commands on.
 *
 * The preload uses only names and disks that no exam task touches (sandvg, /mnt/sandbox,
 * demouser, UID 4001, loop3-5). It does NOT set up NFS, so tasks 6-9 and 24-26 still start
 * from a clean state.
 */
(function () {
  'use strict';
  const Sim = window.Sim;

  // Commands run in order on the named host. Each must succeed.
  const PRELOAD = [
    ['server', 'pvcreate /dev/loop3'],
    ['server', 'vgcreate -s 8M sandvg /dev/loop3'],
    ['server', 'lvcreate -L 1G -n docs sandvg'],
    ['server', 'mkfs.ext4 /dev/sandvg/docs'],
    ['server', 'mkdir -p /mnt/sandbox'],
    ['server', "echo '/dev/sandvg/docs /mnt/sandbox ext4 defaults 0 0' >> /etc/fstab"],
    ['server', 'mount -a'],
    ['server', "echo 'hello from the example volume' > /mnt/sandbox/hello.txt"],
    ['server', 'lvcreate -L 256M -n swap1 sandvg'],
    ['server', 'mkswap /dev/sandvg/swap1'],
    ['server', "echo '/dev/sandvg/swap1 swap swap defaults 0 0' >> /etc/fstab"],
    ['server', 'swapon -a'],
    ['server', 'groupadd demo'],
    ['server', 'useradd -u 4001 -G demo demouser'],
    ['server', 'echo redhat | passwd --stdin demouser'],
    ['client', 'pvcreate /dev/loop3'],
    ['client', 'vgcreate -s 8M sandvg /dev/loop3'],
    ['client', 'lvcreate -L 512M -n scratch sandvg'],
    ['client', 'mkfs.xfs /dev/sandvg/scratch'],
  ];

  // Wrap the lab builder: every lab that is built gets the extra disks and the examples.
  const baseBuild = Sim.buildLab;
  Sim.buildLab = function () {
    const lab = baseBuild();
    for (const h of Object.values(lab.hosts)) {
      h.disks['/dev/loop3'] = { sizeMB: 2048, label: 'disk4', pv: false };
      h.disks['/dev/loop4'] = { sizeMB: 2048, label: 'disk5', pv: false };
      h.disks['/dev/loop5'] = { sizeMB: 2048, label: 'disk6', pv: false };
    }
    const prevLab = Sim.lab;
    Sim.lab = lab;
    try {
      Sim.reboot(lab);
      const session = { server: { user: 'root', cwd: '/root' }, client: { user: 'root', cwd: '/root' } };
      const failures = [];
      for (const [host, cmd] of PRELOAD) {
        const r = Sim.exec(host, cmd, session[host]);
        if (r.code !== 0) failures.push(host + ': ' + cmd + ' -> ' + (r.err || '').trim());
      }
      if (failures.length) console.error('preload failed:', failures);
      Sim.reboot(lab);
    } finally {
      Sim.lab = prevLab;
    }
    return lab;
  };
})();
