-- M4 lists and schedules (M4-06): revisioned schedules, their firing history and the scheduler lease.
-- Lists reuse the suites table created by 0001; their definition lives in data_json.
-- Every table with a workspace_id column enables the ADR-015 tenant_isolation policy through tm_enable_tenant_rls (0011).

CREATE TABLE schedules (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),
  pause_reason TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('manual','owner_revoked','auto_paused_failures','secret_changed','expired')),
  revision BIGINT NOT NULL CHECK(revision>=1),
  owner_id TEXT NOT NULL,
  cursor_at TEXT NOT NULL,
  next_fire_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  CHECK((state='paused')=(pause_reason IS NOT NULL))
);

ALTER TABLE schedules ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX schedules_name ON schedules(workspace_id,name) WHERE state<>'archived';

CREATE INDEX schedules_due ON schedules(next_fire_at) WHERE state='active';

-- A revision is immutable: changing the zone, cron or selection creates the next one.
CREATE TABLE schedule_revisions (
  workspace_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>=1),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  tzdata_version TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,schedule_id,revision)
);

ALTER TABLE schedule_revisions ADD FOREIGN KEY(workspace_id,schedule_id) REFERENCES schedules(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION protect_schedule_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'schedule_revision_immutable' USING ERRCODE='23514'; END $$;

CREATE TRIGGER schedule_revisions_immutable BEFORE UPDATE ON schedule_revisions FOR EACH ROW EXECUTE FUNCTION protect_schedule_revision();

CREATE TRIGGER schedule_revisions_kept BEFORE DELETE ON schedule_revisions FOR EACH ROW EXECUTE FUNCTION protect_schedule_revision();

-- One row per planned occurrence. The unique key makes a duplicated election, a replayed tick or a
-- clock that moved back unable to fire the same instant twice.
CREATE TABLE schedule_firings (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  schedule_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>=1),
  fire_instant TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','waiting','dispatched','skipped','misfire','overlap','blocked')),
  reason_code TEXT,
  batch_id TEXT,
  decided_at TEXT,
  missed_count BIGINT NOT NULL DEFAULT 0 CHECK(missed_count>=0),
  lease_fence BIGINT NOT NULL CHECK(lease_fence>=0),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,schedule_id,revision,fire_instant),
  CHECK((state IN ('claimed','waiting'))=(decided_at IS NULL)),
  CHECK(batch_id IS NULL OR state='dispatched')
);

ALTER TABLE schedule_firings ADD FOREIGN KEY(workspace_id,schedule_id) REFERENCES schedules(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE schedule_firings ADD FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX schedule_firings_pending ON schedule_firings(state,created_at) WHERE state IN ('claimed','waiting');

CREATE INDEX schedule_firings_history ON schedule_firings(workspace_id,schedule_id,fire_instant DESC);

CREATE FUNCTION protect_schedule_firing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' OR OLD.state NOT IN ('claimed','waiting') OR NEW.id<>OLD.id OR NEW.schedule_id<>OLD.schedule_id OR NEW.revision<>OLD.revision OR NEW.fire_instant<>OLD.fire_instant OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'schedule_firing_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER schedule_firings_frozen BEFORE UPDATE ON schedule_firings FOR EACH ROW EXECUTE FUNCTION protect_schedule_firing();

CREATE TRIGGER schedule_firings_kept BEFORE DELETE ON schedule_firings FOR EACH ROW EXECUTE FUNCTION protect_schedule_firing();

-- Deployment-wide election: no workspace_id, so it is not tenant data. Every firing write checks the
-- fence of the leader that makes it.
CREATE TABLE scheduler_leases (
  name TEXT NOT NULL PRIMARY KEY,
  holder TEXT NOT NULL,
  fence BIGINT NOT NULL CHECK(fence>=1),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

SELECT tm_enable_tenant_rls('schedules');

SELECT tm_enable_tenant_rls('schedule_revisions');

SELECT tm_enable_tenant_rls('schedule_firings');
