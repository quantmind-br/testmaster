-- M4 operations (S2b): admin operations ledger, alerts, incident records, signed audit-purge summaries
-- and the retention purge permit that lets the purge controller delete expired immutable rows.

-- workspace_id is NULL for instance-level operations (scheduled backups, isolation release); only the
-- unscoped controller connection ('*') can see or insert them.
CREATE TABLE admin_operations (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL CHECK(kind IN ('backup','restore_verify','admission','reconcile','isolation_release')),
  state TEXT NOT NULL CHECK(state IN ('requested','running','completed','failed')),
  requested_by TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX admin_operations_pending ON admin_operations(kind,state,created_at);

CREATE INDEX admin_operations_scope ON admin_operations(workspace_id,created_at DESC);

CREATE FUNCTION protect_admin_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR OLD.state IN ('completed','failed') THEN RAISE EXCEPTION 'admin_operation_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER admin_operations_frozen BEFORE UPDATE ON admin_operations FOR EACH ROW EXECUTE FUNCTION protect_admin_operation();

CREATE TABLE alerts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  rule TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium')),
  state TEXT NOT NULL CHECK(state IN ('firing','acknowledged','resolved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE UNIQUE INDEX alerts_open_unique ON alerts(workspace_id,rule,subject) WHERE state<>'resolved';

CREATE INDEX alerts_listing ON alerts(workspace_id,state,last_seen_at DESC);

CREATE FUNCTION protect_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id<>OLD.id OR NEW.rule<>OLD.rule OR NEW.subject<>OLD.subject OR NEW.created_at<>OLD.created_at OR NEW.first_seen_at<>OLD.first_seen_at OR OLD.state='resolved' THEN RAISE EXCEPTION 'alert_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER alerts_frozen BEFORE UPDATE ON alerts FOR EACH ROW EXECUTE FUNCTION protect_alert();

CREATE TABLE incidents (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
  category TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','mitigated','resumed','closed')),
  closed_at TEXT,
  PRIMARY KEY(workspace_id,id),
  CHECK((state='closed')=(closed_at IS NOT NULL))
);

CREATE INDEX incidents_listing ON incidents(workspace_id,created_at DESC);

CREATE FUNCTION protect_incident() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END IF; IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.title<>OLD.title OR NEW.severity<>OLD.severity OR NEW.category<>OLD.category OR NEW.created_at<>OLD.created_at OR OLD.state='closed' THEN RAISE EXCEPTION 'incident_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER incidents_frozen BEFORE UPDATE OR DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION protect_incident();

-- The incident record is append-only: corrections are new events.
CREATE TABLE incident_events (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  seq BIGINT NOT NULL CHECK(seq>=1),
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('opened','timeline','evidence','reach','action','action_verified','communication','status','closed')),
  actor TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,incident_id,seq),
  FOREIGN KEY(workspace_id,incident_id) REFERENCES incidents(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER incident_events_immutable BEFORE UPDATE OR DELETE ON incident_events FOR EACH ROW EXECUTE FUNCTION deny_immutable();

-- One row per audit purge, chained by digest and signed with a key derived from the master key.
CREATE TABLE audit_purge_summaries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  from_at TEXT NOT NULL,
  to_at TEXT NOT NULL,
  event_count BIGINT NOT NULL CHECK(event_count>=1),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  previous_digest TEXT CHECK(previous_digest IS NULL OR length(previous_digest)=64),
  signature TEXT NOT NULL CHECK(length(signature)=64),
  key_id TEXT NOT NULL CHECK(length(key_id)=64),
  PRIMARY KEY(workspace_id,id)
);

CREATE TRIGGER audit_purge_summaries_immutable BEFORE UPDATE OR DELETE ON audit_purge_summaries FOR EACH ROW EXECUTE FUNCTION deny_immutable();

-- Retention purge permit: a row `retention:purge-permit:<workspace>` in operational_state, inserted and
-- removed inside the purge transaction, lifts the delete guards for expired audit events, snapshots,
-- analyses and healing proposals of that workspace only. Updates stay forbidden.
CREATE OR REPLACE FUNCTION deny_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN ('audit_events','snapshots','analyses')
     AND EXISTS(SELECT 1 FROM operational_state WHERE key='retention:purge-permit:' || OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'immutable' USING ERRCODE='23514';
END $$;

CREATE OR REPLACE FUNCTION protect_healing_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN IF EXISTS(SELECT 1 FROM operational_state WHERE key='retention:purge-permit:' || OLD.workspace_id) THEN RETURN OLD; END IF; RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END IF; IF NEW.failed_run_id<>OLD.failed_run_id OR NEW.test_id<>OLD.test_id OR NEW.base_revision_id<>OLD.base_revision_id OR NEW.candidate_revision_id<>OLD.candidate_revision_id OR NEW.risk<>OLD.risk OR OLD.status IN ('rejected','verified') OR (OLD.verification_run_id IS NOT NULL AND NEW.verification_run_id IS DISTINCT FROM OLD.verification_run_id) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'healing_proposal_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

SELECT tm_enable_tenant_rls('admin_operations');

SELECT tm_enable_tenant_rls('alerts');

SELECT tm_enable_tenant_rls('incidents');

SELECT tm_enable_tenant_rls('incident_events');

SELECT tm_enable_tenant_rls('audit_purge_summaries');
