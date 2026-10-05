ALTER TABLE artifacts ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE artifacts ALTER COLUMN attempt_id DROP NOT NULL;
ALTER TABLE artifacts ALTER COLUMN snapshot_id DROP NOT NULL;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_provenance_complete CHECK (
  (run_id IS NULL AND attempt_id IS NULL AND snapshot_id IS NULL) OR
  (run_id IS NOT NULL AND attempt_id IS NOT NULL AND snapshot_id IS NOT NULL)
);
