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
);

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
);

CREATE INDEX sessions_principal ON sessions(workspace_id,principal_id,created_at);

INSERT INTO server_tokens(workspace_id,id,created_at,version,data_json,principal_id,token_hash,expires_at,revoked_at)
SELECT (value::jsonb)->>'workspaceId',
       'tok_'||replace(gen_random_uuid()::text,'-',''),
       to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       1,
       jsonb_build_object(
         'name','local',
         'kind','local',
         'scopes',(value::jsonb)#>'{identity,scopes}',
         'grants',COALESCE((value::jsonb)#>'{identity,grants}','[]'::jsonb),
         'audience','testmaster-local',
         'operator',false
       )::text,
       (value::jsonb)#>>'{identity,principalId}',
       substr(key,13),
       (value::jsonb)->>'expiresAt',
       CASE WHEN (value::jsonb)->>'revoked'='true' THEN to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END
FROM operational_state
WHERE key LIKE 'local-token:%';

DELETE FROM operational_state WHERE key LIKE 'local-token:%';
