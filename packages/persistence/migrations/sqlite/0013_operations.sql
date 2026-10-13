-- M4 operations (S2b): admin operations ledger, alerts, incident records, signed audit-purge summaries
-- and the retention purge permit that lets the purge controller delete expired immutable rows.

-- workspace_id is NULL for instance-level operations (scheduled backups, isolation release); only the
-- unscoped controller connection can see them.
CREATE TABLE admin_operations (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL CHECK(kind IN ('backup','restore_verify','admission','reconcile','isolation_release')),
  state TEXT NOT NULL CHECK(state IN ('requested','running','completed','failed')),
  requested_by TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX admin_operations_pending ON admin_operations(kind,state,created_at);

CREATE INDEX admin_operations_scope ON admin_operations(workspace_id,created_at DESC);

CREATE TRIGGER admin_operations_frozen BEFORE UPDATE ON admin_operations WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at OR NEW.workspace_id IS NOT OLD.workspace_id OR OLD.state IN ('completed','failed') BEGIN SELECT RAISE(ABORT,'admin_operation_frozen'); END;

CREATE TABLE alerts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  rule TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium')),
  state TEXT NOT NULL CHECK(state IN ('firing','acknowledged','resolved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX alerts_open_unique ON alerts(workspace_id,rule,subject) WHERE state<>'resolved';

CREATE INDEX alerts_listing ON alerts(workspace_id,state,last_seen_at DESC);

CREATE TRIGGER alerts_frozen BEFORE UPDATE ON alerts WHEN NEW.id<>OLD.id OR NEW.rule<>OLD.rule OR NEW.subject<>OLD.subject OR NEW.created_at<>OLD.created_at OR NEW.first_seen_at<>OLD.first_seen_at OR OLD.state='resolved' BEGIN SELECT RAISE(ABORT,'alert_frozen'); END;

CREATE TABLE incidents (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
  category TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','mitigated','resumed','closed')),
  closed_at TEXT,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((state='closed')=(closed_at IS NOT NULL))
) STRICT;

CREATE INDEX incidents_listing ON incidents(workspace_id,created_at DESC);

CREATE TRIGGER incidents_frozen BEFORE UPDATE ON incidents WHEN NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.title<>OLD.title OR NEW.severity<>OLD.severity OR NEW.category<>OLD.category OR NEW.created_at<>OLD.created_at OR OLD.state='closed' BEGIN SELECT RAISE(ABORT,'incident_frozen'); END;

CREATE TRIGGER incidents_no_delete BEFORE DELETE ON incidents BEGIN SELECT RAISE(ABORT,'immutable'); END;

-- The incident record is append-only: corrections are new events.
CREATE TABLE incident_events (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq>=1),
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('opened','timeline','evidence','reach','action','action_verified','communication','status','closed')),
  actor TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,incident_id,seq),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,incident_id) REFERENCES incidents(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER incident_events_no_update BEFORE UPDATE ON incident_events BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER incident_events_no_delete BEFORE DELETE ON incident_events BEGIN SELECT RAISE(ABORT,'immutable'); END;

-- One row per audit purge, chained by digest and signed with a key derived from the master key.
CREATE TABLE audit_purge_summaries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  from_at TEXT NOT NULL,
  to_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK(event_count>=1),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  previous_digest TEXT CHECK(previous_digest IS NULL OR length(previous_digest)=64),
  signature TEXT NOT NULL CHECK(length(signature)=64),
  key_id TEXT NOT NULL CHECK(length(key_id)=64),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER audit_purge_summaries_no_update BEFORE UPDATE ON audit_purge_summaries BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER audit_purge_summaries_no_delete BEFORE DELETE ON audit_purge_summaries BEGIN SELECT RAISE(ABORT,'immutable'); END;

-- Retention purge permit: a row `retention:purge-permit:<workspace>` in operational_state, inserted and
-- removed inside the purge transaction, lifts the delete guards for expired audit events, snapshots,
-- analyses and healing proposals of that workspace only. Updates stay forbidden.
DROP TRIGGER audit_events_no_delete;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events WHEN NOT EXISTS(SELECT 1 FROM operational_state WHERE key='retention:purge-permit:' || OLD.workspace_id) BEGIN SELECT RAISE(ABORT,'immutable'); END;

DROP TRIGGER snapshots_no_delete;

CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots WHEN NOT EXISTS(SELECT 1 FROM operational_state WHERE key='retention:purge-permit:' || OLD.workspace_id) BEGIN SELECT RAISE(ABORT,'immutable'); END;

DROP TRIGGER analyses_no_delete;

CREATE TRIGGER analyses_no_delete BEFORE DELETE ON analyses WHEN NOT EXISTS(SELECT 1 FROM operational_state WHERE key='retention:purge-permit:' || OLD.workspace_id) BEGIN SELECT RAISE(ABORT,'immutable'); END;

DROP TRIGGER healing_proposals_no_delete;

CREATE TRIGGER healing_proposals_no_delete BEFORE DELETE ON healing_proposals WHEN NOT EXISTS(SELECT 1 FROM operational_state WHERE key='retention:purge-permit:' || OLD.workspace_id) BEGIN SELECT RAISE(ABORT,'immutable'); END;
