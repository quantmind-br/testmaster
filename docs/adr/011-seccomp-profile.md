# ADR 011: Engine-matched seccomp and Chromium namespace confinement

Status: accepted for the local hardened Docker profile.

## Context

The unchanged Playwright v1.63.0 seccomp profile embeds a historical Moby default.
On the installed Docker Engine 29.8.1 / runc 1.5.2 / libpathrs 0.2.6, it crashes OCI initialization
in `pathrs_reopen` before the entrypoint. Disabling seccomp or Chromium's sandbox is not acceptable.

## Decision

`containers/generate-seccomp.mjs` uses the vendored Moby profiles `seccomp/v0.2.3` default,
which [Docker's `docker-v29.8.1` go.mod](https://raw.githubusercontent.com/moby/moby/docker-v29.8.1/go.mod)
requires. The generator proves by structural comparison that the entire
[Playwright profile](https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json)
is the [original Moby snapshot](https://raw.githubusercontent.com/moby/moby/d0d99b04cf6e00ed3fc27e81fc3d94e7eda70af3/profiles/seccomp/default.json)
plus exactly unconditional `clone`, `setns`, `unshare` allows. It applies that delta to the current default.

A separate, explicit SEC-014 exception allows `chroot` with no capability added.
The current default gates this syscall on `CAP_SYS_CHROOT`, removed by `--cap-drop ALL`,
which prevents Chromium's namespace sandbox from shrinking `/proc/self/fdinfo/`.
Seccomp permits a syscall; it grants no capability. Linux still requires `CAP_SYS_CHROOT`
in the caller's user namespace. The non-root, cap-dropped container process therefore gets
`EPERM`, while Chromium can confine its own child user namespace. All remaining current
Moby default rules and Docker executor flags are preserved.

## Evidence and consequences

`packages/sandbox/src/docker/isolation.docker.test.ts` requires actual Chromium startup with
`chromiumSandbox: true`, and separately asserts that `/usr/sbin/chroot` from the container's
own process fails with `Operation not permitted`. It also checks zero effective capabilities,
seccomp mode, read-only rootfs, network denial, resource enforcement and cancellation.
Sources and SHA-256 hashes are in `containers/NOTICE`, `containers/seccomp/provenance.json`
and each `containers/images.lock.json` entry. Upstream inputs remain byte-identical;
regeneration is offline and deterministic. This ADR does not claim rootless validation.
