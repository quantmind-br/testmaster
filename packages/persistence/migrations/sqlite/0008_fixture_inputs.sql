CREATE TABLE fixture_inputs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(id GLOB 'art_*'),
  project_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 200),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,created_by) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(storage_key='fixture-inputs/' || workspace_id || '/' || project_id || '/' || content_hash)
) STRICT;
CREATE INDEX fixture_inputs_project ON fixture_inputs(workspace_id,project_id);
CREATE TRIGGER fixture_inputs_immutable_update BEFORE UPDATE ON fixture_inputs BEGIN SELECT RAISE(ABORT,'immutable fixture input'); END;
CREATE TRIGGER fixture_inputs_immutable_delete BEFORE DELETE ON fixture_inputs BEGIN SELECT RAISE(ABORT,'immutable fixture input'); END;
CREATE TRIGGER fixture_inputs_id_namespace BEFORE INSERT ON fixture_inputs WHEN EXISTS(SELECT 1 FROM artifacts WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'artifact identifier collision'); END;
CREATE TRIGGER artifacts_fixture_namespace BEFORE INSERT ON artifacts WHEN EXISTS(SELECT 1 FROM fixture_inputs WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'fixture identifier collision'); END;
