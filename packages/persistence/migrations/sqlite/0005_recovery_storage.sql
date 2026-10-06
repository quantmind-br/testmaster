CREATE TABLE blob_reference_counts (
  workspace_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  references_count INTEGER NOT NULL CHECK(references_count>=0),
  checked_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,storage_key),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
) STRICT;
CREATE TABLE backup_object_holds (
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,artifact_id,backup_id),
  FOREIGN KEY(workspace_id,artifact_id) REFERENCES artifacts(workspace_id,id)
) STRICT;
CREATE TABLE upload_leases (
  workspace_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,upload_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
) STRICT;
