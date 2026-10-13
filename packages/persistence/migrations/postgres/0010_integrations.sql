-- M4 integrations core (C5): provider-bound integrations and the durable inbound webhook dedupe record.
-- Both tables carry workspace_id, so they enable and force the ADR-015 tenant_isolation policy themselves.

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
  UNIQUE(workspace_id,provider,name)
);

ALTER TABLE integrations ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION protect_integration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider<>OLD.provider OR NEW.created_at<>OLD.created_at OR (OLD.state='revoked' AND NEW.state<>'revoked') THEN RAISE EXCEPTION 'integration_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER integrations_provider_frozen BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION protect_integration();

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
  CHECK((outcome='tampered')=(original_id IS NOT NULL)),
  CHECK(outcome<>'ignored' OR ignored_reason IS NOT NULL)
);

ALTER TABLE inbound_webhook_deliveries ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE inbound_webhook_deliveries ADD FOREIGN KEY(original_id) REFERENCES inbound_webhook_deliveries(id) DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX inbound_webhook_deliveries_scoped ON inbound_webhook_deliveries(workspace_id,provider,delivery_id) WHERE outcome<>'tampered' AND workspace_id IS NOT NULL;

CREATE UNIQUE INDEX inbound_webhook_deliveries_unattributed ON inbound_webhook_deliveries(provider,delivery_id) WHERE outcome<>'tampered' AND workspace_id IS NULL;

CREATE INDEX inbound_webhook_deliveries_integration ON inbound_webhook_deliveries(workspace_id,integration_id,received_at DESC);

CREATE FUNCTION protect_inbound_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.outcome='tampered' OR NEW.id<>OLD.id OR NEW.provider<>OLD.provider OR NEW.delivery_id<>OLD.delivery_id OR NEW.payload_sha256<>OLD.payload_sha256 OR NEW.installation_key<>OLD.installation_key OR NEW.project_id<>OLD.project_id OR NEW.event_type<>OLD.event_type OR NEW.action<>OLD.action OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.original_id IS DISTINCT FROM OLD.original_id OR NEW.received_at<>OLD.received_at OR OLD.outcome IN ('accepted','ignored') THEN RAISE EXCEPTION 'inbound_delivery_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER inbound_webhook_deliveries_frozen BEFORE UPDATE ON inbound_webhook_deliveries FOR EACH ROW EXECUTE FUNCTION protect_inbound_delivery();

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

ALTER TABLE integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON integrations USING (current_setting('testmaster.workspace', true) = '*' OR workspace_id = current_setting('testmaster.workspace', true)) WITH CHECK (current_setting('testmaster.workspace', true) = '*' OR workspace_id = current_setting('testmaster.workspace', true));

ALTER TABLE inbound_webhook_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE inbound_webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON inbound_webhook_deliveries USING (current_setting('testmaster.workspace', true) = '*' OR workspace_id = current_setting('testmaster.workspace', true)) WITH CHECK (current_setting('testmaster.workspace', true) = '*' OR workspace_id = current_setting('testmaster.workspace', true));
