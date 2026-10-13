# Rootless Docker (validated reference daemon)

ADR-016 makes rootless Docker the validated M4 sandbox daemon. This page records what the
reference host needed, how the test suites select the rootless daemon, and where it differs from a
rootful daemon. Rootful hardened Docker stays supported for the local profile.

## Host changes made on the reference host (Arch Linux)

| Change | Command or file |
| --- | --- |
| Packages | `sudo pacman -S --needed --noconfirm rootlesskit slirp4netns docker-rootless-extras` (`docker-rootless-extras` is in chaotic-aur and installs `/usr/bin/dockerd-rootless.sh`, `/usr/lib/systemd/user/docker.service`, `/usr/lib/systemd/user/docker.socket`, `/usr/lib/sysctl.d/99-docker-rootless.conf`) |
| Socket activation | `systemctl --user enable --now docker.socket` (creates `~/.config/systemd/user/sockets.target.wants/docker.socket`) |
| Daemon socket | `unix:///run/user/<uid>/docker.sock`; data root `~/.local/share/docker` |
| Already present | `/etc/subuid` and `/etc/subgid` (`<user>:100000:65536`), `loginctl enable-linger`, `kernel.unprivileged_userns_clone=1`, `net.ipv4.ip_unprivileged_port_start=1024` |
| Images | the daemon has its own store: `docker save testmaster-runner:local testmaster-runner-python:local \| DOCKER_HOST=unix:///run/user/<uid>/docker.sock docker load`, and `docker pull` for the digests pinned in `deploy/compose/compose.yaml` and the PostgreSQL test image |

`DOCKER_HOST` is never exported globally, so every other tool keeps using the rootful daemon.
Selecting the rootless daemon is always explicit: `DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock`
for a command, `Environment=DOCKER_HOST=unix://%t/docker.sock` in a systemd unit, or the
`docker-rootless` vitest project.

Verify the daemon:

```console
$ DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock docker info --format '{{json .SecurityOptions}}'
["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]
```

The cgroup v2 controllers `cpu`, `memory` and `pids` must be delegated to the user
(`/etc/systemd/system/user@.service.d/delegate.conf` with `Delegate=cpu cpuset io memory pids`).
Without them Docker accepts `--memory` and `--pids-limit` but does not enforce them.

## How TestMaster uses it

* `testmaster doctor` reports `runtime.mode: "rootless"` from the daemon's `SecurityOptions`.
* `DockerExecutor.doctor()` reads `MemoryLimit`, `SwapLimit`, `CpuCfsQuota` and `PidsLimit`; an
  explicit `false` adds the diagnostic `resource_limits_unsupported` and the runtime is not
  available. After every container is created the executor checks the limits it actually received
  (`resourceLimitsEnforced`) and stops the attempt with `security_precondition_failed` when any is
  missing, so a daemon that silently drops a limit cannot run an Attempt.
* `pnpm test:docker:rootless` (vitest project `docker-rootless`) runs the sandbox security suites
  and the rootless-only journeys against the rootless daemon. Its global setup exports
  `DOCKER_HOST` and `TESTMASTER_JOURNEY_DOCKER_HOST` and fails the run unless the daemon reports
  `name=rootless`, so rootless evidence cannot come from the rootful daemon by accident. PostgreSQL
  test containers started by the same run also live on the rootless daemon.

## Differences from the rootful daemon

* Container uid 0 is the operator; the uid the sandbox uses (1000) maps into the subordinate range
  of `/etc/subuid` (for example 100999), never to host root or to the operator. Bind-mounted
  directories must be traversable by that uid; the executor creates them world-readable where the
  container needs them.
* Containers use `--network none` and reach their target only through the host-side broker on a
  unix socket, so slirp4netns / rootlesskit port forwarding does not change the network boundary.
* Published ports below 1024 need `net.ipv4.ip_unprivileged_port_start`; the compose stack uses
  8443 and 55432.
* The cgroup `cpuset` and `io` controllers are often not delegated; TestMaster does not rely on
  them.
* Images live in a separate store and must be loaded or pulled once per daemon.
