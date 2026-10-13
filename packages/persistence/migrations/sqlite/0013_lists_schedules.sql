-- M4 lists and schedules (M4-06): revisioned schedules, their firing history and the scheduler lease.
-- Lists reuse the suites table created by 0001; their definition lives in data_json.

CREATE TABLE schedules (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),
  pause_reason TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('manual','owner_revoked','auto_paused_failures','secret_changed','expired')),
  revision INTEGER NOT NULL CHECK(revision>=1),
  owner_id TEXT NOT NULL,
  cursor_at TEXT NOT NULL,
  next_fire_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((state='paused')=(pause_reason IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX schedules_name ON schedules(workspace_id,name) WHERE state<>'archived';

CREATE INDEX schedules_due ON schedules(next_fire_at) WHERE state='active';

-- A revision is immutable: changing the zone, cron or selection creates the next one.
CREATE TABLE schedule_revisions (
  workspace_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  tzdata_version TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,schedule_id,revision),
  FOREIGN KEY(workspace_id,schedule_id) REFERENCES schedules(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER schedule_revisions_immutable BEFORE UPDATE ON schedule_revisions BEGIN SELECT RAISE(ABORT,'schedule_revision_immutable'); END;

CREATE TRIGGER schedule_revisions_kept BEFORE DELETE ON schedule_revisions BEGIN SELECT RAISE(ABORT,'schedule_revision_immutable'); END;

-- One row per planned occurrence. The unique key makes a duplicated election, a replayed tick or a
-- clock that moved back unable to fire the same instant twice.
CREATE TABLE schedule_firings (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  schedule_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  fire_instant TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','waiting','dispatched','skipped','misfire','overlap','blocked')),
  reason_code TEXT,
  batch_id TEXT,
  decided_at TEXT,
  missed_count INTEGER NOT NULL DEFAULT 0 CHECK(missed_count>=0),
  lease_fence INTEGER NOT NULL CHECK(lease_fence>=0),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,schedule_id) REFERENCES schedules(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,schedule_id,revision,fire_instant),
  CHECK((state IN ('claimed','waiting'))=(decided_at IS NULL)),
  CHECK(batch_id IS NULL OR state='dispatched')
) STRICT;

CREATE INDEX schedule_firings_pending ON schedule_firings(state,created_at) WHERE state IN ('claimed','waiting');

CREATE INDEX schedule_firings_history ON schedule_firings(workspace_id,schedule_id,fire_instant DESC);

CREATE TRIGGER schedule_firings_frozen BEFORE UPDATE ON schedule_firings WHEN OLD.state NOT IN ('claimed','waiting') OR NEW.id<>OLD.id OR NEW.schedule_id<>OLD.schedule_id OR NEW.revision<>OLD.revision OR NEW.fire_instant<>OLD.fire_instant OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'schedule_firing_frozen'); END;

CREATE TRIGGER schedule_firings_kept BEFORE DELETE ON schedule_firings BEGIN SELECT RAISE(ABORT,'schedule_firing_frozen'); END;

-- Deployment-wide election: no workspace_id, so it is not tenant data. Every firing write checks the
-- fence of the leader that makes it.
CREATE TABLE scheduler_leases (
  name TEXT NOT NULL PRIMARY KEY,
  holder TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence>=1),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
