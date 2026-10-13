-- M4 notifications (ADR-021): one durable delivery per (outbox event, integration) with an attempt log,
-- plus an index that lets the dispatcher scan a workspace's recent outbox events.

CREATE INDEX outbox_created_idx ON outbox(workspace_id,created_at);

CREATE TABLE notification_deliveries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  integration_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('slack','email','webhook')),
  event_ref TEXT NOT NULL CHECK(length(event_ref) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100),
  delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 200),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at TEXT,
  outcome_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(outcome_uncertain IN (0,1)),
  last_reason_code TEXT,
  last_error TEXT,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  window_started_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  delivered_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,integration_id) REFERENCES integrations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,event_ref,integration_id),
  UNIQUE(workspace_id,delivery_id),
  CHECK((state='delivered')=(delivered_at IS NOT NULL))
) STRICT;

CREATE INDEX notification_deliveries_due ON notification_deliveries(workspace_id,state,next_attempt_at);

CREATE INDEX notification_deliveries_integration ON notification_deliveries(workspace_id,integration_id,created_at DESC);

-- The frozen identity of a delivery never changes; a delivered row is terminal and a dead letter may
-- only reopen to pending (authorized requeue).
CREATE TRIGGER notification_deliveries_frozen BEFORE UPDATE ON notification_deliveries WHEN NEW.id<>OLD.id OR NEW.integration_id<>OLD.integration_id OR NEW.provider<>OLD.provider OR NEW.event_ref<>OLD.event_ref OR NEW.event_type<>OLD.event_type OR NEW.delivery_id<>OLD.delivery_id OR NEW.payload_sha256<>OLD.payload_sha256 OR NEW.created_at<>OLD.created_at OR OLD.state='delivered' OR (OLD.state='dead_letter' AND NEW.state NOT IN ('dead_letter','pending')) BEGIN SELECT RAISE(ABORT,'notification_delivery_frozen'); END;

CREATE TRIGGER notification_deliveries_no_delete BEFORE DELETE ON notification_deliveries WHEN OLD.state='pending' BEGIN SELECT RAISE(ABORT,'notification_delivery_frozen'); END;

CREATE TABLE notification_attempts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  delivery_ref TEXT NOT NULL,
  number INTEGER NOT NULL CHECK(number>=1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('in_flight','delivered','failed','rejected','abandoned')),
  http_status INTEGER CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
  reason_code TEXT,
  detail TEXT,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,delivery_ref) REFERENCES notification_deliveries(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,delivery_ref,number)
) STRICT;

-- A finished attempt is history: only an in-flight attempt may change.
CREATE TRIGGER notification_attempts_frozen BEFORE UPDATE ON notification_attempts WHEN OLD.outcome<>'in_flight' OR NEW.delivery_ref<>OLD.delivery_ref OR NEW.number<>OLD.number OR NEW.started_at<>OLD.started_at BEGIN SELECT RAISE(ABORT,'notification_attempt_frozen'); END;
