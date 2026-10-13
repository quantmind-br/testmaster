-- M4 integrations core (C5): provider-bound integrations and the durable inbound webhook dedupe record.

CREATE TABLE integrations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL CHECK(provider IN ('github','slack','email','webhook')),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','paused','revoked')),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,provider,name)
) STRICT;

CREATE TRIGGER integrations_provider_frozen BEFORE UPDATE ON integrations WHEN NEW.provider<>OLD.provider OR NEW.created_at<>OLD.created_at OR (OLD.state='revoked' AND NEW.state<>'revoked') BEGIN SELECT RAISE(ABORT,'integration_frozen'); END;

-- workspace_id is NULL only for a delivery whose installation maps to no workspace; it is still recorded
-- so the replay and tamper checks hold, and it is invisible to every tenant-scoped connection.
CREATE TABLE inbound_webhook_deliveries (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  provider TEXT NOT NULL CHECK(provider IN ('github','slack','email','webhook')),
  delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 200),
  integration_id TEXT,
  installation_key TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 200),
  action TEXT NOT NULL DEFAULT '',
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  outcome TEXT NOT NULL CHECK(outcome IN ('received','accepted','ignored','failed','tampered')),
  ignored_reason TEXT,
  reference TEXT,
  error_code TEXT,
  original_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts>=1),
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(original_id) REFERENCES inbound_webhook_deliveries(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((outcome='tampered')=(original_id IS NOT NULL)),
  CHECK(outcome<>'ignored' OR ignored_reason IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX inbound_webhook_deliveries_scoped ON inbound_webhook_deliveries(workspace_id,provider,delivery_id) WHERE outcome<>'tampered' AND workspace_id IS NOT NULL;

CREATE UNIQUE INDEX inbound_webhook_deliveries_unattributed ON inbound_webhook_deliveries(provider,delivery_id) WHERE outcome<>'tampered' AND workspace_id IS NULL;

CREATE INDEX inbound_webhook_deliveries_integration ON inbound_webhook_deliveries(workspace_id,integration_id,received_at DESC);

CREATE TRIGGER inbound_webhook_deliveries_frozen BEFORE UPDATE ON inbound_webhook_deliveries WHEN OLD.outcome='tampered' OR NEW.id<>OLD.id OR NEW.provider<>OLD.provider OR NEW.delivery_id<>OLD.delivery_id OR NEW.payload_sha256<>OLD.payload_sha256 OR NEW.installation_key<>OLD.installation_key OR NEW.project_id<>OLD.project_id OR NEW.event_type<>OLD.event_type OR NEW.action<>OLD.action OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.original_id IS NOT OLD.original_id OR NEW.received_at<>OLD.received_at OR OLD.outcome IN ('accepted','ignored') BEGIN SELECT RAISE(ABORT,'inbound_delivery_frozen'); END;
