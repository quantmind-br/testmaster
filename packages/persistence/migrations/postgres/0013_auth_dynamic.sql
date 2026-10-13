-- M4 target dynamic authentication (SEC-023, SEC-024, M4-03): per-profile session state, the
-- single-flight lease that keeps a rotating refresh token from being used twice, and the pending
-- OAuth/OIDC authorization records (state, nonce and PKCE verifier reference).
-- Both tables carry workspace_id, so they enable the ADR-015 tenant_isolation policy through tm_enable_tenant_rls (0011).

CREATE TABLE auth_profile_state (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  session_state TEXT NOT NULL CHECK(session_state IN ('unauthenticated','authenticated','expired','reauth_required','revoked','locked')),
  reason TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  last_refresh_at TEXT,
  refresh_window_started_at TEXT,
  refresh_count BIGINT NOT NULL DEFAULT 0 CHECK(refresh_count>=0),
  refresh_failures BIGINT NOT NULL DEFAULT 0 CHECK(refresh_failures>=0),
  cooldown_until TEXT,
  otp_failures BIGINT NOT NULL DEFAULT 0 CHECK(otp_failures>=0),
  otp_window_started_at TEXT,
  otp_locked_until TEXT,
  lease_holder TEXT,
  lease_until TEXT,
  fence BIGINT NOT NULL DEFAULT 0 CHECK(fence>=0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,profile_id),
  CHECK((lease_holder IS NULL)=(lease_until IS NULL))
);

ALTER TABLE auth_profile_state ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_profile_state ADD FOREIGN KEY(workspace_id,profile_id) REFERENCES auth_profiles(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE auth_authorizations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  profile_id TEXT NOT NULL,
  state_hash TEXT NOT NULL CHECK(length(state_hash)=64),
  nonce TEXT,
  verifier_secret_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,state_hash)
);

ALTER TABLE auth_authorizations ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_authorizations ADD FOREIGN KEY(workspace_id,profile_id) REFERENCES auth_profiles(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX auth_authorizations_profile ON auth_authorizations(workspace_id,profile_id,created_at DESC);

CREATE FUNCTION protect_auth_authorization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state_hash<>OLD.state_hash OR NEW.profile_id<>OLD.profile_id OR NEW.verifier_secret_id<>OLD.verifier_secret_id OR NEW.redirect_uri<>OLD.redirect_uri OR NEW.nonce IS DISTINCT FROM OLD.nonce OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN RAISE EXCEPTION 'auth_authorization_frozen' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER auth_authorizations_frozen BEFORE UPDATE ON auth_authorizations FOR EACH ROW EXECUTE FUNCTION protect_auth_authorization();

CREATE UNIQUE INDEX auth_checkpoints_pending ON auth_checkpoints(workspace_id,attempt_id,auth_profile_id) WHERE state='pending';

SELECT tm_enable_tenant_rls('auth_profile_state');

SELECT tm_enable_tenant_rls('auth_authorizations');
