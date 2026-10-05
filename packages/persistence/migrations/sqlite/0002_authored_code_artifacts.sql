CREATE TABLE artifacts_authored (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT, attempt_id TEXT, revision_id TEXT NOT NULL, snapshot_id TEXT,
  hash TEXT, bytes INTEGER NOT NULL CHECK(bytes>=0), storage_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available','missing','expired','partial')),
  redaction_status TEXT NOT NULL CHECK(redaction_status IN ('redacted','restrictedRaw','not_applicable')),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,attempt_id) REFERENCES attempts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,revision_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,snapshot_id) REFERENCES snapshots(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,snapshot_id,run_id,attempt_id,revision_id) REFERENCES snapshots(workspace_id,id,run_id,attempt_id,revision_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(state<>'available' OR hash IS NOT NULL),
  CHECK((run_id IS NULL AND attempt_id IS NULL AND snapshot_id IS NULL) OR
        (run_id IS NOT NULL AND attempt_id IS NOT NULL AND snapshot_id IS NOT NULL))
) STRICT;
INSERT INTO artifacts_authored SELECT * FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_authored RENAME TO artifacts;
CREATE INDEX artifacts_lookup ON artifacts(workspace_id,run_id,snapshot_id);
