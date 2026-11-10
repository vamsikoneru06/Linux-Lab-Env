# Linux-Lab-Env

**Live site:** https://vamsikoneru06.github.io/Linux-Lab-Env/ (runs in your browser, nothing to install)


A simulated two-host RHEL lab that runs entirely in your browser. There are no
containers, no VMs, no loop devices and no disk images. The "disks" are records
in memory, so this uses almost no real space.

Topics: LVM, NFS, AutoFS, Users, Groups. 16 tasks with exam-style scenarios,
hints, solutions and automatic checks.

## Prerequisites

- Node.js 18 or newer (only to run the tiny static server; there are no npm packages to install)
- A modern browser (Chrome, Edge or Firefox)

## Start

```bash
cd Linux-Lab-Env
npm start
```

Then open <http://127.0.0.1:3000> in your browser. The server binds to 127.0.0.1 only.

## Using it

- Two terminals, `server` and `client`, on the right. Type commands as root. Up and down arrows recall history, Ctrl+L clears the screen.
- Each task on the left has a scenario, a collapsed Hint, a collapsed Solution and a Check button. Each check shows PASS or FAIL with the reason.
- **Check all**: runs every check.
- **Simulate reboot**: rebuilds runtime state from the persistent config (fstab, exports, enabled services, autofs maps), then re-runs all checks. Use it to test persistence.
- **Reset lab**: destroys everything and rebuilds a clean lab. Progress is lost.
- **Mock exam**: resets the lab, picks 8 random tasks (with their prerequisites), starts a 60-minute timer and hides hints and solutions. At the end it simulates a reboot and grades every check.

Progress and lab state are saved in this browser's localStorage. Other browsers and other machines start fresh.

## Supported commands (the subset the tasks need)

- LVM: `pvcreate pvs vgcreate vgs vgextend lvcreate lvs lvextend lvreduce mkfs.xfs mkfs.ext4 mkswap swapon swapoff`
- Mounts and disks: `mount umount df lsblk blkid`
- Files: `ls cat echo cp mv rm mkdir touch chmod chown chgrp tee grep wc`, plus `> >> |  && ;`
- Users and groups: `useradd usermod userdel groupadd groupdel gpasswd passwd chage id groups getent su sudo visudo sed`
- Services: `systemctl exportfs showmount ping`

Not supported: `vi`/`nano` (use `echo ... >> file` or `tee`), `dnf`, `firewall-cmd`, `semanage`, interactive prompts.

## Files

- `server.js`: static server, no dependencies
- `index.html`, `style.css`, `app.js`: UI
- `tasks.js`: the 16 tasks, hints, solutions and checks
- `sim/core.js`: shell parser, in-memory filesystem, hosts, reboot logic, save and load
- `sim/storage.js`: LVM, mkfs, mount, swap, df, lsblk
- `sim/users.js`: users, groups, passwd, chage, sudo, visudo, sed
- `sim/net.js`: systemctl, NFS exports, autofs maps and automount on access

## Reset from the command line

Clear the lab in the browser's developer console:

```js
localStorage.removeItem('rhlab.v1'); localStorage.removeItem('rhlab.progress.v1'); location.reload();
```

Or click **Reset lab**.

## How it differs from a real RHEL system

See the report in the chat that came with this lab. In short: there is no real kernel,
no SELinux, no firewalld, no real NFS or autofs daemons, no real timing and no real
disks. Output formats are approximate. The checks look at simulated state, so a
command that works here may behave differently on a real exam system.
