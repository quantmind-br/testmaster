-- M5-02 self-hosted tunnels (ADR-031): one row per tunnel, its one-use open token hash, the
-- session the relay holds and the metered stream and byte counters audited at close.

CREATE TABLE tunnels (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  target_address TEXT NOT NULL CHECK(target_address IN ('127.0.0.1','::1')),
  target_port INTEGER NOT NULL CHECK(target_port BETWEEN 1 AND 65535),
  state TEXT NOT NULL CHECK(state IN ('requested','active','closing','closed','expired','revoked')),
  created_by TEXT NOT NULL,
  owner_actor_json TEXT NOT NULL,
  open_token_hash TEXT CHECK(open_token_hash IS NULL OR length(open_token_hash)=64),
  open_token_expires_at TEXT NOT NULL,
  public_key TEXT,
  certificate_sha256 TEXT CHECK(certificate_sha256 IS NULL OR length(certificate_sha256)=64),
  ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds BETWEEN 60 AND 3600),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  last_heartbeat_at TEXT,
  relay_id TEXT,
  streams_opened INTEGER NOT NULL DEFAULT 0 CHECK(streams_opened>=0),
  streams_refused INTEGER NOT NULL DEFAULT 0 CHECK(streams_refused>=0),
  bytes_total INTEGER NOT NULL DEFAULT 0 CHECK(bytes_total>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(open_token_hash),
  CHECK((state IN ('closed','expired','revoked'))=(closed_at IS NOT NULL)),
  CHECK(state<>'active' OR (public_key IS NOT NULL AND certificate_sha256 IS NOT NULL)),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX tunnels_project ON tunnels(workspace_id,project_id,created_at DESC);

CREATE INDEX tunnels_state ON tunnels(state,workspace_id);

CREATE TRIGGER tunnels_frozen BEFORE UPDATE ON tunnels WHEN NEW.project_id<>OLD.project_id OR NEW.target_address<>OLD.target_address OR NEW.target_port<>OLD.target_port OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at OR (OLD.state IN ('closed','expired','revoked') AND NEW.state<>OLD.state) OR (OLD.public_key IS NOT NULL AND NEW.public_key IS NOT OLD.public_key) BEGIN SELECT RAISE(ABORT,'tunnel_frozen'); END;
