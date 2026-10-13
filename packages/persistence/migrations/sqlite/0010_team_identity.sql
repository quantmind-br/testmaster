-- Team identity (ADR-017): password credentials, browser sessions and one bearer-token table.
-- Every bearer token now lives in server_tokens; the operational_state local-token rows move there.
CREATE TABLE password_credentials (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  principal_id TEXT NOT NULL,
  login TEXT NOT NULL CHECK(length(login) BETWEEN 3 AND 64),
  password_hash TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_count>=0),
  failure_window_started_at TEXT,
  locked_until TEXT,
  recovery_hash TEXT,
  recovery_expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(login),
  UNIQUE(workspace_id,principal_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sessions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(token_hash),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX sessions_principal ON sessions(workspace_id,principal_id,created_at);

INSERT INTO server_tokens(workspace_id,id,created_at,version,data_json,principal_id,token_hash,expires_at,revoked_at)
SELECT json_extract(value,'$.workspaceId'),
       'tok_'||lower(hex(randomblob(16))),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       1,
       json_object(
         'name','local',
         'kind','local',
         'scopes',json(json_extract(value,'$.identity.scopes')),
         'grants',json(COALESCE(json_extract(value,'$.identity.grants'),'[]')),
         'audience','testmaster-local',
         'operator',json('false')
       ),
       json_extract(value,'$.identity.principalId'),
       substr(key,13),
       json_extract(value,'$.expiresAt'),
       CASE WHEN json_extract(value,'$.revoked') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END
FROM operational_state
WHERE key LIKE 'local-token:%';

DELETE FROM operational_state WHERE key LIKE 'local-token:%';
