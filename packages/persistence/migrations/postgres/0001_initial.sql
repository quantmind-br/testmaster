-- Forward-only M0–M2 relational schema. Money amounts are integer decimal strings.

CREATE TABLE workspaces (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('single-user','server','distributed')), settings_version INTEGER NOT NULL DEFAULT 1 CHECK(settings_version>=1), quota_policy_id TEXT NOT NULL DEFAULT 'local',
  PRIMARY KEY(workspace_id,id),
  UNIQUE(id),
  CHECK(workspace_id=id)
);

CREATE TABLE principals (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL CHECK(kind IN ('human','service')), display_name TEXT NOT NULL, disabled_at TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  principal_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('org_owner','org_admin','maintainer','runner','reviewer','viewer','service_account')),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,principal_id)
);

CREATE TABLE projects (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  name TEXT NOT NULL, slug TEXT NOT NULL, default_environment_id TEXT, archived_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,slug)
);

CREATE TABLE environments (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, name TEXT NOT NULL, active_revision_id TEXT NOT NULL, archived_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,project_id,name),
  UNIQUE(workspace_id,id,project_id)
);

CREATE TABLE environment_revisions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  environment_id TEXT NOT NULL, network_profile TEXT NOT NULL CHECK(network_profile IN ('public','private','local-loopback')), production INTEGER NOT NULL CHECK(production IN (0,1)),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,id,environment_id)
);

CREATE TABLE secret_references (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL, locator TEXT NOT NULL, secret_version INTEGER NOT NULL CHECK(secret_version>=1), revoked_at TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE auth_profiles (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('form','basic','bearer','api-key','cookie','oauth','oidc','manual')),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE workers (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK(state IN ('enrolling','ready','draining','revoked','offline')), last_heartbeat_at TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE sources (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, active_revision_id TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE source_revisions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  source_id TEXT NOT NULL, parent_id TEXT, content_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','partial','needs_input','invalid')), size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,id,source_id)
);

CREATE TABLE source_chunks (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  revision_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), content_hash TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,revision_id,ordinal)
);

CREATE TABLE code_snapshots (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE features (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, stable_key TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,project_id,stable_key)
);

CREATE TABLE requirements (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, origin_kind TEXT NOT NULL CHECK(origin_kind IN ('explicit','user_spec','inferred','observed')), approval TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE discovery_jobs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, inputs_fingerprint TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('queued','extracting','normalizing','exploring','planning','validating','completed','cancelled','failed')),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE exploration_jobs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('queued','running','completed','cancelled','failed')), inputs_fingerprint TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE proposal_batches (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected','stale')),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE proposals (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  batch_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('proposed','accepted','rejected')),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE tests (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, name TEXT NOT NULL, active_revision_id TEXT, archived_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,id,project_id)
);

CREATE TABLE test_revisions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  test_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=1), parent_id TEXT, content_hash TEXT NOT NULL, runner_kind TEXT NOT NULL CHECK(runner_kind IN ('playwright','http','python')), origin TEXT NOT NULL CHECK(origin IN ('manual','generated','healed','imported')), code_artifact_id TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,test_id,ordinal),
  UNIQUE(workspace_id,id,test_id)
);

CREATE TABLE suites (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  name TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE suite_members (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  suite_id TEXT NOT NULL, test_id TEXT NOT NULL, environment_id TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,suite_id,test_id)
);

CREATE TABLE batches (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  requested_count INTEGER NOT NULL CHECK(requested_count>=0),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE batch_members (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  batch_id TEXT NOT NULL, run_id TEXT NOT NULL, member_key TEXT NOT NULL, requested INTEGER NOT NULL CHECK(requested IN (0,1)), dependency INTEGER NOT NULL CHECK(dependency IN (0,1)),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,batch_id,run_id),
  UNIQUE(workspace_id,batch_id,member_key)
);

CREATE TABLE runs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  test_id TEXT NOT NULL, revision_id TEXT NOT NULL, environment_revision_id TEXT NOT NULL, batch_id TEXT, mode TEXT NOT NULL CHECK(mode IN ('replay','agent')), phase TEXT NOT NULL CHECK(phase IN ('queued','preparing','running','collecting','analyzing','completed')), status TEXT NOT NULL, outcome TEXT CHECK(outcome IN ('passed','failed','blocked','cancelled','inconclusive')), gate TEXT NOT NULL CHECK(gate IN ('pending','passed','failed','not_applicable')), cleanup_outcome TEXT NOT NULL CHECK(cleanup_outcome IN ('not_required','passed','failed','pending','inconclusive')), analysis_status TEXT NOT NULL CHECK(analysis_status IN ('not_requested','pending','complete','partial','unavailable')),
  PRIMARY KEY(workspace_id,id),
  CHECK((phase='completed' AND outcome IS NOT NULL AND status=outcome) OR (phase<>'completed' AND outcome IS NULL AND status=phase)),
  UNIQUE(workspace_id,id,revision_id)
);

CREATE TABLE job_leases (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  queue TEXT NOT NULL, resource_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','completed','cancelled','reconciliation_required')), available_at TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100), lease_owner TEXT, lease_expires_at TEXT, fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), dispatchable INTEGER NOT NULL DEFAULT 1 CHECK(dispatchable IN (0,1)),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,queue,resource_id),
  CHECK((state='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR state<>'leased')
);

CREATE TABLE attempts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT NOT NULL, number INTEGER NOT NULL CHECK(number>=1), worker_id TEXT, seed INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL CHECK(phase IN ('queued','preparing','running','collecting','analyzing','completed')), started_at TEXT, ended_at TEXT, outcome TEXT CHECK(outcome IN ('passed','failed','blocked','cancelled','inconclusive')), job_id TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence>=1), lease_owner TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,run_id,number),
  UNIQUE(workspace_id,id,run_id),
  UNIQUE(workspace_id,job_id,fence)
);

CREATE TABLE steps (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  attempt_id TEXT NOT NULL, plan_step_id TEXT NOT NULL, step_index INTEGER NOT NULL CHECK(step_index>=0), status TEXT NOT NULL CHECK(status IN ('pending','running','passed','failed','blocked','cancelled','inconclusive','skipped','not_run')),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,attempt_id,plan_step_id),
  UNIQUE(workspace_id,attempt_id,step_index)
);

CREATE TABLE observations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  attempt_id TEXT NOT NULL, event_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq>=0), fence INTEGER NOT NULL CHECK(fence>=1),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,event_id),
  UNIQUE(workspace_id,attempt_id,seq)
);

CREATE TABLE variables (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  batch_id TEXT, producer_run_id TEXT NOT NULL, producer_step_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('string','number','boolean','object','array','null')), encrypted_value_ref TEXT, taint TEXT NOT NULL CHECK(taint IN ('public','sensitive')),
  PRIMARY KEY(workspace_id,id),
  CHECK(taint<>'sensitive' OR encrypted_value_ref IS NOT NULL),
  UNIQUE(workspace_id,producer_run_id,producer_step_id,name)
);

CREATE TABLE resources (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  creator_attempt_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('planned','created','cleanup_pending','cleaned','orphaned','uncertain')),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE snapshots (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision_id TEXT NOT NULL, manifest_hash TEXT NOT NULL, committed_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,id,run_id,attempt_id,revision_id)
);

CREATE TABLE artifacts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, hash TEXT, bytes INTEGER NOT NULL CHECK(bytes>=0), storage_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('available','missing','expired','partial')), redaction_status TEXT NOT NULL CHECK(redaction_status IN ('redacted','restrictedRaw','not_applicable')),
  PRIMARY KEY(workspace_id,id),
  CHECK(state<>'available' OR hash IS NOT NULL)
);

CREATE TABLE approvals (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  actor_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, environment_revision_id TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, revision_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE auth_checkpoints (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, auth_profile_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','completed','cancelled','expired')), expires_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE audit_events (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT NOT NULL, request_id TEXT NOT NULL, timestamp TEXT NOT NULL, before_hash TEXT, after_hash TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE outbox (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq>=0), type TEXT NOT NULL, payload_ref TEXT NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','delivered','dead_letter')), dispatchable INTEGER NOT NULL DEFAULT 1 CHECK(dispatchable IN (0,1)),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,aggregate_id,seq)
);

CREATE TABLE idempotency_receipts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  actor_scope TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL CHECK(length(key) BETWEEN 16 AND 128), request_hash TEXT NOT NULL, response_json TEXT NOT NULL, expires_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,actor_scope,operation,key)
);

CREATE TABLE budget_limits (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, currency TEXT NOT NULL, scale INTEGER NOT NULL CHECK(scale BETWEEN 0 AND 18), amount TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,project_id)
);

CREATE TABLE budget_reservations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, estimate_json TEXT NOT NULL, cost_json TEXT, usage_json TEXT, idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','settled','released')), release_reason TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,project_id,idempotency_key)
);

CREATE TABLE model_calls (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('normalize','plan','resolve_action','generate_code','analyze','heal')), provider TEXT NOT NULL, model TEXT NOT NULL, prompt_hash TEXT NOT NULL, latency INTEGER NOT NULL CHECK(latency>=0), outcome TEXT NOT NULL CHECK(outcome IN ('success','invalid','failed','cancelled')), reservation_id TEXT, cache_hit INTEGER NOT NULL CHECK(cache_hit IN (0,1)), repair_attempt INTEGER NOT NULL CHECK(repair_attempt>=0),
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE usage_entries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, reservation_id TEXT NOT NULL, cost_json TEXT NOT NULL, usage_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,reservation_id)
);

CREATE TABLE consents (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, provider_id TEXT NOT NULL, data_classes_json TEXT NOT NULL, granted_at TEXT NOT NULL, revoked_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,project_id,provider_id)
);

CREATE TABLE agent_installs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, target TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('installed','removed','conflict')),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,project_id,target,path)
);

CREATE TABLE server_tokens (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  principal_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT, revoked_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(token_hash)
);

CREATE TABLE cursor_signing_keys (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  key_hash TEXT NOT NULL, encrypted_key_ref TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,key_hash)
);

CREATE TABLE deletion_operations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  physical_state TEXT NOT NULL CHECK(physical_state IN ('pending','running','completed','failed')), revoked_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE memory_entries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  project_id TEXT NOT NULL, approval TEXT, expires_at TEXT, tombstone_at TEXT,
  PRIMARY KEY(workspace_id,id)
);

CREATE TABLE evaluations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}',
  corpus_digest TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);

ALTER TABLE principals ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE memberships ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE memberships ADD FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE projects ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE projects ADD FOREIGN KEY(workspace_id,default_environment_id) REFERENCES environments(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE environments ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE environments ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE environments ADD FOREIGN KEY(workspace_id,active_revision_id) REFERENCES environment_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE environment_revisions ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE environment_revisions ADD FOREIGN KEY(workspace_id,environment_id) REFERENCES environments(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE secret_references ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_profiles ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_profiles ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE workers ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE sources ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE sources ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE sources ADD FOREIGN KEY(workspace_id,active_revision_id) REFERENCES source_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE source_revisions ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE source_revisions ADD FOREIGN KEY(workspace_id,source_id) REFERENCES sources(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE source_revisions ADD FOREIGN KEY(workspace_id,parent_id) REFERENCES source_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE source_chunks ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE source_chunks ADD FOREIGN KEY(workspace_id,revision_id) REFERENCES source_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE code_snapshots ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE code_snapshots ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE features ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE features ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE requirements ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE requirements ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE requirements ADD FOREIGN KEY(workspace_id,approval) REFERENCES approvals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE discovery_jobs ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE discovery_jobs ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE exploration_jobs ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE exploration_jobs ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE proposal_batches ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE proposal_batches ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE proposals ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE proposals ADD FOREIGN KEY(workspace_id,batch_id) REFERENCES proposal_batches(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE tests ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE tests ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE tests ADD FOREIGN KEY(workspace_id,active_revision_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE test_revisions ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE test_revisions ADD FOREIGN KEY(workspace_id,test_id) REFERENCES tests(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE test_revisions ADD FOREIGN KEY(workspace_id,parent_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE test_revisions ADD FOREIGN KEY(workspace_id,code_artifact_id) REFERENCES artifacts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE suites ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE suite_members ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE suite_members ADD FOREIGN KEY(workspace_id,suite_id) REFERENCES suites(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE suite_members ADD FOREIGN KEY(workspace_id,test_id) REFERENCES tests(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE suite_members ADD FOREIGN KEY(workspace_id,environment_id) REFERENCES environments(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE batches ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE batch_members ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE batch_members ADD FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE batch_members ADD FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs ADD FOREIGN KEY(workspace_id,test_id) REFERENCES tests(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs ADD FOREIGN KEY(workspace_id,revision_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs ADD FOREIGN KEY(workspace_id,environment_revision_id) REFERENCES environment_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs ADD FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs ADD FOREIGN KEY(workspace_id,revision_id,test_id) REFERENCES test_revisions(workspace_id,id,test_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE job_leases ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE attempts ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE attempts ADD FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE attempts ADD FOREIGN KEY(workspace_id,worker_id) REFERENCES workers(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE attempts ADD FOREIGN KEY(workspace_id,job_id) REFERENCES job_leases(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE steps ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE steps ADD FOREIGN KEY(workspace_id,attempt_id) REFERENCES attempts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE observations ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE observations ADD FOREIGN KEY(workspace_id,attempt_id) REFERENCES attempts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE variables ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE variables ADD FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE variables ADD FOREIGN KEY(workspace_id,producer_run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE resources ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE resources ADD FOREIGN KEY(workspace_id,creator_attempt_id) REFERENCES attempts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE snapshots ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE snapshots ADD FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE snapshots ADD FOREIGN KEY(workspace_id,attempt_id) REFERENCES attempts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE snapshots ADD FOREIGN KEY(workspace_id,revision_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE snapshots ADD FOREIGN KEY(workspace_id,attempt_id,run_id) REFERENCES attempts(workspace_id,id,run_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE snapshots ADD FOREIGN KEY(workspace_id,run_id,revision_id) REFERENCES runs(workspace_id,id,revision_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifacts ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifacts ADD FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifacts ADD FOREIGN KEY(workspace_id,attempt_id) REFERENCES attempts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifacts ADD FOREIGN KEY(workspace_id,revision_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifacts ADD FOREIGN KEY(workspace_id,snapshot_id) REFERENCES snapshots(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE artifacts ADD FOREIGN KEY(workspace_id,snapshot_id,run_id,attempt_id,revision_id) REFERENCES snapshots(workspace_id,id,run_id,attempt_id,revision_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE approvals ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE approvals ADD FOREIGN KEY(workspace_id,actor_id) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE approvals ADD FOREIGN KEY(workspace_id,reviewer_id) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE approvals ADD FOREIGN KEY(workspace_id,environment_revision_id) REFERENCES environment_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_checkpoints ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_checkpoints ADD FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_checkpoints ADD FOREIGN KEY(workspace_id,attempt_id) REFERENCES attempts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE auth_checkpoints ADD FOREIGN KEY(workspace_id,auth_profile_id) REFERENCES auth_profiles(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE audit_events ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE outbox ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE idempotency_receipts ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE budget_limits ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE budget_limits ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE budget_reservations ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE budget_reservations ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE model_calls ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE model_calls ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE model_calls ADD FOREIGN KEY(workspace_id,reservation_id) REFERENCES budget_reservations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE usage_entries ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE usage_entries ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE usage_entries ADD FOREIGN KEY(workspace_id,reservation_id) REFERENCES budget_reservations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE consents ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE consents ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE agent_installs ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE agent_installs ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE server_tokens ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE server_tokens ADD FOREIGN KEY(workspace_id,principal_id) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE cursor_signing_keys ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE deletion_operations ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE memory_entries ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE memory_entries ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE memory_entries ADD FOREIGN KEY(workspace_id,approval) REFERENCES approvals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE evaluations ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX runs_history ON runs(workspace_id,test_id,created_at DESC,id DESC);

CREATE INDEX jobs_queue ON job_leases(state,available_at,priority);

CREATE INDEX artifacts_lookup ON artifacts(workspace_id,run_id,snapshot_id);

CREATE INDEX resource_orphans ON resources(workspace_id,state,created_at);

CREATE TABLE operational_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

INSERT INTO operational_state(key,value) VALUES ('admission','enabled');

CREATE FUNCTION deny_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END $$;

CREATE TRIGGER environment_revisions_immutable BEFORE UPDATE OR DELETE ON environment_revisions FOR EACH ROW EXECUTE FUNCTION deny_immutable();

CREATE TRIGGER source_revisions_immutable BEFORE UPDATE OR DELETE ON source_revisions FOR EACH ROW EXECUTE FUNCTION deny_immutable();

CREATE TRIGGER code_snapshots_immutable BEFORE UPDATE OR DELETE ON code_snapshots FOR EACH ROW EXECUTE FUNCTION deny_immutable();

CREATE TRIGGER test_revisions_immutable BEFORE UPDATE OR DELETE ON test_revisions FOR EACH ROW EXECUTE FUNCTION deny_immutable();

CREATE TRIGGER snapshots_immutable BEFORE UPDATE OR DELETE ON snapshots FOR EACH ROW EXECUTE FUNCTION deny_immutable();

CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION deny_immutable();

CREATE FUNCTION protect_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.phase='completed' AND (NEW.phase<>OLD.phase OR NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.status<>OLD.status OR NEW.data_json<>OLD.data_json) THEN RAISE EXCEPTION 'terminal_immutable' USING ERRCODE='23514'; END IF; IF position(NEW.phase in 'queued preparing running collecting analyzing completed') < position(OLD.phase in 'queued preparing running collecting analyzing completed') THEN RAISE EXCEPTION 'phase_regression' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;

CREATE TRIGGER runs_protection BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION protect_run();
