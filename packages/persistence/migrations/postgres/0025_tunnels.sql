-- M5-02 self-hosted tunnels (ADR-031): one row per tunnel, its one-use open token hash, the
-- session the relay holds and the metered stream and byte counters audited at close.
-- The table carries workspace_id, so it enables the ADR-015 tenant_isolation policy through tm_enable_tenant_rls (0011).

CREATE TABLE tunnels (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  target_address TEXT NOT NULL CHECK(target_address IN ('127.0.0.1','::1')),
  target_port BIGINT NOT NULL CHECK(target_port BETWEEN 1 AND 65535),
  state TEXT NOT NULL CHECK(state IN ('requested','active','closing','closed','expired','revoked')),
  created_by TEXT NOT NULL,
  owner_actor_json TEXT NOT NULL,
  open_token_hash TEXT CHECK(open_token_hash IS NULL OR length(open_token_hash)=64),
  open_token_expires_at TEXT NOT NULL,
  public_key TEXT,
  certificate_sha256 TEXT CHECK(certificate_sha256 IS NULL OR length(certificate_sha256)=64),
  ttl_seconds BIGINT NOT NULL CHECK(ttl_seconds BETWEEN 60 AND 3600),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  last_heartbeat_at TEXT,
  relay_id TEXT,
  streams_opened BIGINT NOT NULL DEFAULT 0 CHECK(streams_opened>=0),
  streams_refused BIGINT NOT NULL DEFAULT 0 CHECK(streams_refused>=0),
  bytes_total BIGINT NOT NULL DEFAULT 0 CHECK(bytes_total>=0),
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(open_token_hash),
  CHECK((state IN ('closed','expired','revoked'))=(closed_at IS NOT NULL)),
  CHECK(state<>'active' OR (public_key IS NOT NULL AND certificate_sha256 IS NOT NULL))
);

ALTER TABLE tunnels ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX tunnels_project ON tunnels(workspace_id,project_id,created_at DESC);

CREATE INDEX tunnels_state ON tunnels(state,workspace_id);

CREATE FUNCTION protect_tunnel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id<>OLD.project_id OR NEW.target_address<>OLD.target_address OR NEW.target_port<>OLD.target_port OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at OR (OLD.state IN ('closed','expired','revoked') AND NEW.state<>OLD.state) OR (OLD.public_key IS NOT NULL AND NEW.public_key IS DISTINCT FROM OLD.public_key) THEN RAISE EXCEPTION 'tunnel_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER tunnels_frozen BEFORE UPDATE ON tunnels FOR EACH ROW EXECUTE FUNCTION protect_tunnel();

SELECT tm_enable_tenant_rls('tunnels');
