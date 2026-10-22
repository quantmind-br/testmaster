# Tunnels

A tunnel lets the remote workers of a TestMaster server test an app that listens on loopback on a
developer's machine, without exposing that machine to its network (ADR-031, M5-02). It needs the
server profile: the relay runs inside the API process, and only remote workers
(`worker start --mode remote`, see [workers](workers.md)) run tunnelled Runs, always in the Docker
sandbox.

## Starting a tunnel

On the developer's machine, with a token that may execute in the project:

```bash
export TESTMASTER_API_KEY=...        # or `testmaster auth login`
testmaster --endpoint https://testmaster.example.com tunnel start \
  --project prj_... --target 127.0.0.1:3000 [--ttl 900]
```

- The target is a literal `127.0.0.1:<port>` or `[::1]:<port>`. Names (`localhost`), LAN
  addresses, `0.0.0.0` and the metadata address are refused before anything is created.
- The command creates the tunnel, opens its session with the one-use open token (valid 60 s, never
  printed, stored on the server only as a hash) and stays in the foreground. Stderr shows one JSON
  line per fact: `tunnel.created` (with the `tunnelId`), `tunnel.ready`, `tunnel.stream.opened`
  and `tunnel.closed`.
- It ends, printing `{tunnelId, reason}`, when the session ends: `ttl_expired` (default 900 s,
  60 to 3600), `owner_revoked`, `heartbeat_lost` (three missed 10 s heartbeats on either side),
  `quota_exhausted`, `relay_stopped` or Ctrl-C. A tunnel never reopens: start a new one.

The agent connects outward over HTTPS only and never listens. It ends each stream's TLS with a
certificate made for the session; workers pin that certificate's fingerprint, so the relay
forwards ciphertext. Plain HTTP between the agent and the app stays on the developer's loopback.

## Running through a tunnel

1. The environment's `baseUrl` must be the tunnel's target exactly, for example
   `http://127.0.0.1:3000` (`localhost` counts as `127.0.0.1`).
2. Admit the Run with `tunnelId` (`POST /v1/runs` or `testmaster test run <id> --env <env>
   --tunnel <tun>` with `--endpoint`). Each Run needs a current approval whose `actionSet` names
   `tunnel:<id>`, even outside production; the first refusal (`approval_required`) carries the
   exact binding to approve.
3. A remote worker claims the Run, and its egress dials the tunnel for that target only. Any other
   origin, including another loopback port the environment allows, is refused with
   `tunnel_target_mismatch`.

## Ending and limits

- `tunnel stop <id>` (`DELETE /v1/tunnels/{id}`) revokes: new streams are refused at once, open
  streams close within 5 s and every Run still bound to the tunnel ends `cancelled` with
  `tunnel_lost`. The same happens when the session ends for any other reason; the lease
  reconciler also expires unopened tokens, ends sessions past their TTL or without heartbeats, and
  revokes a tunnel whose owner lost execute access.
- Cancelling a Run, or a worker stopping or losing its lease, closes only that Attempt's streams;
  the tunnel stays open for the next Run.
- Per session: 32 concurrent streams (the 33rd is refused with `QUOTA_EXCEEDED`), 10 MiB/s and
  512 MiB in total. Each stream has a 256 KiB window, so a slow reader cannot grow memory.
- `tunnel status <id>` shows the state, whether the session is `live`, its certificate fingerprint
  and its usage. The audit trail records creation, opening, every stream decision, quota refusals
  and the end with a hash of the final usage; never a payload or a token.

## What the relay operator can see

The relay sees stream counts, sizes and timing, not content. Whoever starts a tunnel exposes that
one port to every approved Run of the project until the tunnel ends.
