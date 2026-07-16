# Steps to bootstrap a Dev VM

## Recommended

- OS: Ubuntu 24.04.4 LTS
- VM: g4dn.xlarge + 100GB gp3

## SSH on Ubuntu 24.04 (`2222`)

Ubuntu 24.04 AWS images enable two defaults that break the desired branch dev VM SSH setup:

- `ec2-instance-connect` ships an `ssh.service` drop-in that replaces `ExecStart` and injects `AuthorizedKeysCommand`
- `ssh.socket` keeps socket activation as the real listener source

Because of this, only editing `sshd_config` to `Port 2222` is not enough. `sshd` may still listen on `22`, and the VM may stop honoring the `ubuntu` user's `authorized_keys` as the single source of truth.

Required fix:

- write a dedicated SSH config snippet with `Port 2222`
- override `ssh.service` `ExecStart` back to plain `sshd -D $SSHD_OPTS`
- disable `ssh.socket`
- reload systemd and restart `ssh.service`

Commands:

```bash
sudo install -d -m 0755 /etc/systemd/system/ssh.service.d

sudo tee /etc/ssh/sshd_config.d/99-dev-vm.conf >/dev/null <<'EOF'
Port 2222
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
EOF

# `ec2-instance-connect` ships a drop-in that replaces ExecStart. Ensure our
# override sorts *after* it (lexicographically) so systemd applies it last.
sudo tee /etc/systemd/system/ssh.service.d/zz-static-keys.conf >/dev/null <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/sbin/sshd -D $SSHD_OPTS
EOF

sudo systemctl disable --now ssh.socket || true
sudo rm -f /etc/systemd/system/ssh.service.d/00-socket.conf
sudo rm -f /etc/systemd/system/ssh.socket.d/addresses.conf
sudo systemctl daemon-reload
sudo systemctl enable --now ssh.service
sudo systemctl restart ssh.service
```

Verification:

- `sudo sshd -T | grep '^port'` -> `port 2222`
- `sudo ss -tlnp | grep ssh` -> listener on `2222`
