CREATE TABLE fixture_inputs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(id LIKE 'art\_%'),
  project_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 200),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  size_bytes BIGINT NOT NULL CHECK(size_bytes>=0),
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,created_by) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(storage_key='fixture-inputs/' || workspace_id || '/' || project_id || '/' || content_hash)
);
CREATE INDEX fixture_inputs_project ON fixture_inputs(workspace_id,project_id);
CREATE TRIGGER fixture_inputs_immutable BEFORE UPDATE OR DELETE ON fixture_inputs FOR EACH ROW EXECUTE FUNCTION deny_immutable();
CREATE FUNCTION guard_fixture_artifact_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_TABLE_NAME='fixture_inputs' AND EXISTS(SELECT 1 FROM artifacts WHERE id=NEW.id)) OR
     (TG_TABLE_NAME='artifacts' AND EXISTS(SELECT 1 FROM fixture_inputs WHERE id=NEW.id)) THEN
    RAISE EXCEPTION 'artifact identifier collision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixture_inputs_id_namespace BEFORE INSERT ON fixture_inputs FOR EACH ROW EXECUTE FUNCTION guard_fixture_artifact_namespace();
CREATE TRIGGER artifacts_fixture_namespace BEFORE INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION guard_fixture_artifact_namespace();
