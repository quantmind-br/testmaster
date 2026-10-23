-- M5 distributed profile (ADR-035): the controller registry, named leases with fencing, the ownership
-- of remote Attempts, the deployment-wide proof nonce cache, per-controller metric windows and the
-- cancel request of an exploration job. Every table except remote_attempts is deployment-wide (no
-- workspace_id), so none of them is tenant data.

CREATE TABLE controller_instances (
  id TEXT NOT NULL PRIMARY KEY,
  internal_origin TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  stopped_at TEXT
) STRICT;

CREATE INDEX controller_instances_heartbeat ON controller_instances(heartbeat_at) WHERE stopped_at IS NULL;

-- One row per elected loop. `fence` grows on every takeover, so a holder that lost the lease is
-- refused by every write that checks it. Replaces scheduler_leases; leases are ephemeral, so no row is copied.
CREATE TABLE controller_leases (
  name TEXT NOT NULL PRIMARY KEY,
  holder TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence>=1),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

DROP TABLE scheduler_leases;

-- Routing and ownership only: the AttemptSession lives in memory on the controller that claimed the
-- Attempt, so another controller forwards to `controller_id` instead of taking it over.
CREATE TABLE remote_attempts (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence>=0),
  state TEXT NOT NULL CHECK(state IN ('active','settled','failed','dropped')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX remote_attempts_controller ON remote_attempts(controller_id,state);

CREATE INDEX remote_attempts_worker ON remote_attempts(workspace_id,worker_id,state);

-- A signed worker or tunnel call is accepted once deployment-wide: the row is the nonce.
CREATE TABLE worker_proof_nonces (
  key TEXT NOT NULL PRIMARY KEY,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX worker_proof_nonces_expiry ON worker_proof_nonces(expires_at);

-- Counters a controller flushes every minute into the row of its current hour; the SLO report sums the
-- rows of live controllers. `name` carries the metric and, for per-workspace counters, the workspace id.
CREATE TABLE controller_metrics (
  controller_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY(controller_id,window_start,name)
) STRICT;

CREATE INDEX controller_metrics_window ON controller_metrics(window_start);

-- Set by `ExploreService.cancel`; the controller that runs the job polls it and aborts.
ALTER TABLE discovery_jobs ADD COLUMN cancel_requested_at TEXT;
