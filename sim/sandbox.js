/*
 * Practice sandbox: a preloaded lab for playing with commands. It is separate from the
 * exam lab (Sim.buildLab / Reset lab), so the task checks are never affected.
 * Adds three more 2G disks per host and some ready-made examples, so you can try
 * commands on existing LVM volumes, a mounted filesystem, swap, a user and an NFS mount.
 */
(function () {
  'use strict';
  const Sim = window.Sim;

  // Commands run in order on the named host. Each must succeed; a failure is reported.
  const PRELOAD = [
    ['server', 'pvcreate /dev/loop3'],
    ['server', 'vgcreate -s 8M sandvg /dev/loop3'],
    ['server', 'lvcreate -L 1G -n docs sandvg'],
    ['server', 'mkfs.ext4 /dev/sandvg/docs'],
    ['server', 'mkdir -p /mnt/sandbox'],
    ['server', "echo '/dev/sandvg/docs /mnt/sandbox ext4 defaults 0 0' >> /etc/fstab"],
    ['server', 'mount -a'],
    ['server', "echo 'hello from the sandbox' > /mnt/sandbox/hello.txt"],
    ['server', 'lvcreate -L 256M -n swap1 sandvg'],
    ['server', 'mkswap /dev/sandvg/swap1'],
    ['server', "echo '/dev/sandvg/swap1 swap swap defaults 0 0' >> /etc/fstab"],
    ['server', 'swapon -a'],
    ['server', 'groupadd team'],
    ['server', 'useradd -u 2001 -G team alice'],
    ['server', 'echo redhat | passwd --stdin alice'],
    ['server', "echo '/share 192.168.50.0/24(rw,sync,no_root_squash)' >> /etc/exports"],
    ['server', 'exportfs -ra'],
    ['server', 'systemctl enable --now nfs-server'],
    ['client', 'pvcreate /dev/loop3'],
    ['client', 'vgcreate -s 8M sandvg /dev/loop3'],
    ['client', 'lvcreate -L 512M -n scratch sandvg'],
    ['client', 'mkfs.xfs /dev/sandvg/scratch'],
    ['client', 'mkdir -p /mnt/nfs'],
    ['client', "echo 'server:/share /mnt/nfs nfs defaults,_netdev 0 0' >> /etc/fstab"],
    ['client', 'mount -a'],
  ];

  // Adds the extra disks, the preloaded examples, and a clean boot.
  Sim.buildSandbox = function () {
    const lab = Sim.buildLab();
    for (const h of Object.values(lab.hosts)) {
      h.disks['/dev/loop3'] = { sizeMB: 2048, label: 'disk4', pv: false };
      h.disks['/dev/loop4'] = { sizeMB: 2048, label: 'disk5', pv: false };
      h.disks['/dev/loop5'] = { sizeMB: 2048, label: 'disk6', pv: false };
    }
    Sim.lab = lab;
    Sim.reboot(lab);
    const session = { server: { user: 'root', cwd: '/root' }, client: { user: 'root', cwd: '/root' } };
    const failures = [];
    for (const [host, cmd] of PRELOAD) {
      const r = Sim.exec(host, cmd, session[host]);
      if (r.code !== 0) failures.push(host + ': ' + cmd + ' -> ' + (r.err || '').trim());
    }
    if (failures.length) console.error('sandbox preload failed:', failures);
    Sim.reboot(lab);
    return lab;
  };
})();
