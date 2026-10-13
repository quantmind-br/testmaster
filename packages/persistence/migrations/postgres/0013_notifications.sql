-- M4 notifications (ADR-021): one durable delivery per (outbox event, integration) with an attempt log,
-- plus an index that lets the dispatcher scan a workspace's recent outbox events.
-- Both tables carry workspace_id, so they enable the ADR-015 tenant_isolation policy through tm_enable_tenant_rls (0011).

CREATE INDEX outbox_created_idx ON outbox(workspace_id,created_at);

CREATE TABLE notification_deliveries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  integration_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('slack','email','webhook')),
  event_ref TEXT NOT NULL CHECK(length(event_ref) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100),
  delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 200),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','dead_letter')),
  attempts BIGINT NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at TEXT,
  outcome_uncertain BIGINT NOT NULL DEFAULT 0 CHECK(outcome_uncertain IN (0,1)),
  last_reason_code TEXT,
  last_error TEXT,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  window_started_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  delivered_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,event_ref,integration_id),
  UNIQUE(workspace_id,delivery_id),
  CHECK((state='delivered')=(delivered_at IS NOT NULL))
);

ALTER TABLE notification_deliveries ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE notification_deliveries ADD FOREIGN KEY(workspace_id,integration_id) REFERENCES integrations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX notification_deliveries_due ON notification_deliveries(workspace_id,state,next_attempt_at);

CREATE INDEX notification_deliveries_integration ON notification_deliveries(workspace_id,integration_id,created_at DESC);

-- The frozen identity of a delivery never changes; a delivered row is terminal and a dead letter may
-- only reopen to pending (authorized requeue).
CREATE FUNCTION protect_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN IF OLD.state='pending' THEN RAISE EXCEPTION 'notification_delivery_frozen' USING ERRCODE='23514'; END IF; RETURN OLD; END IF; IF NEW.id<>OLD.id OR NEW.integration_id<>OLD.integration_id OR NEW.provider<>OLD.provider OR NEW.event_ref<>OLD.event_ref OR NEW.event_type<>OLD.event_type OR NEW.delivery_id<>OLD.delivery_id OR NEW.payload_sha256<>OLD.payload_sha256 OR NEW.created_at<>OLD.created_at OR OLD.state='delivered' OR (OLD.state='dead_letter' AND NEW.state NOT IN ('dead_letter','pending')) THEN RAISE EXCEPTION 'notification_delivery_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER notification_deliveries_frozen BEFORE UPDATE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION protect_notification_delivery();

CREATE TRIGGER notification_deliveries_no_delete BEFORE DELETE ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION protect_notification_delivery();

CREATE TABLE notification_attempts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  delivery_ref TEXT NOT NULL,
  number BIGINT NOT NULL CHECK(number>=1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('in_flight','delivered','failed','rejected','abandoned')),
  http_status BIGINT CHECK(http_status IS NULL OR http_status BETWEEN 100 AND 599),
  uncertain BIGINT NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
  reason_code TEXT,
  detail TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,delivery_ref,number)
);

ALTER TABLE notification_attempts ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE notification_attempts ADD FOREIGN KEY(workspace_id,delivery_ref) REFERENCES notification_deliveries(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

-- A finished attempt is history: only an in-flight attempt may change.
CREATE FUNCTION protect_notification_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.outcome<>'in_flight' OR NEW.delivery_ref<>OLD.delivery_ref OR NEW.number<>OLD.number OR NEW.started_at<>OLD.started_at THEN RAISE EXCEPTION 'notification_attempt_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER notification_attempts_frozen BEFORE UPDATE ON notification_attempts FOR EACH ROW EXECUTE FUNCTION protect_notification_attempt();

SELECT tm_enable_tenant_rls('notification_deliveries');

SELECT tm_enable_tenant_rls('notification_attempts');
