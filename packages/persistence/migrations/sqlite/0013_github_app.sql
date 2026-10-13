-- M4 GitHub App (ADR-020): installations, repository bindings, pull request state, deployment statuses and check publications.

CREATE TABLE github_installations (
  workspace_id TEXT NOT NULL,
  installation_id TEXT NOT NULL CHECK(length(installation_id) BETWEEN 1 AND 40),
  integration_id TEXT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('User','Organization')),
  repository_selection TEXT NOT NULL CHECK(repository_selection IN ('all','selected')),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  revoked_reason TEXT,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  events_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(workspace_id,installation_id),
  UNIQUE(installation_id),
  CHECK((state='revoked')=(revoked_reason IS NOT NULL)),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,integration_id) REFERENCES integrations(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER github_installations_frozen BEFORE UPDATE ON github_installations WHEN NEW.installation_id<>OLD.installation_id OR NEW.integration_id<>OLD.integration_id OR NEW.created_at<>OLD.created_at OR (OLD.state='revoked' AND NEW.state<>'revoked') BEGIN SELECT RAISE(ABORT,'github_installation_frozen'); END;

CREATE TABLE github_repositories (
  workspace_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL CHECK(length(repository_id) BETWEEN 1 AND 40),
  full_name TEXT NOT NULL CHECK(length(full_name) BETWEEN 3 AND 140),
  private INTEGER NOT NULL CHECK(private IN (0,1)),
  granted INTEGER NOT NULL CHECK(granted IN (0,1)),
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(workspace_id,installation_id,repository_id),
  FOREIGN KEY(workspace_id,installation_id) REFERENCES github_installations(workspace_id,installation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX github_repositories_full_name ON github_repositories(workspace_id,full_name);

CREATE TRIGGER github_repositories_frozen BEFORE UPDATE ON github_repositories WHEN NEW.repository_id<>OLD.repository_id OR NEW.installation_id<>OLD.installation_id BEGIN SELECT RAISE(ABORT,'github_repository_frozen'); END;

CREATE TABLE github_pulls (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK(pr_number>=1),
  head_sha TEXT NOT NULL CHECK(length(head_sha)=40),
  base_sha TEXT NOT NULL CHECK(length(base_sha)=40),
  merge_sha TEXT CHECK(merge_sha IS NULL OR length(merge_sha)=40),
  fork INTEGER NOT NULL CHECK(fork IN (0,1)),
  draft INTEGER NOT NULL CHECK(draft IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('awaiting_preview','running','completed','superseded','timed_out','denied','skipped','closed')),
  reason_code TEXT,
  project_id TEXT,
  environment_id TEXT,
  preview_url TEXT,
  deployment_id TEXT,
  preview_deadline_at TEXT,
  batch_id TEXT,
  superseded_by TEXT CHECK(superseded_by IS NULL OR length(superseded_by)=40),
  gate TEXT CHECK(gate IS NULL OR gate IN ('pending','passed','failed','not_applicable')),
  comment_id TEXT,
  comment_dirty INTEGER NOT NULL DEFAULT 1 CHECK(comment_dirty IN (0,1)),
  comment_attempts INTEGER NOT NULL DEFAULT 0 CHECK(comment_attempts>=0),
  comment_next_at TEXT,
  comment_error TEXT,
  result_json TEXT,
  report_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,installation_id,repository_id,pr_number,head_sha),
  FOREIGN KEY(workspace_id,installation_id,repository_id) REFERENCES github_repositories(workspace_id,installation_id,repository_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX github_pulls_open ON github_pulls(workspace_id,state,preview_deadline_at);

CREATE INDEX github_pulls_pr ON github_pulls(workspace_id,installation_id,repository_id,pr_number,created_at DESC);

CREATE TRIGGER github_pulls_frozen BEFORE UPDATE ON github_pulls WHEN NEW.id<>OLD.id OR NEW.head_sha<>OLD.head_sha OR NEW.pr_number<>OLD.pr_number OR NEW.repository_id<>OLD.repository_id OR NEW.installation_id<>OLD.installation_id OR NEW.integration_id<>OLD.integration_id OR NEW.created_at<>OLD.created_at OR (OLD.state IN ('completed','superseded','timed_out','denied','skipped','closed') AND NEW.state<>OLD.state) BEGIN SELECT RAISE(ABORT,'github_pull_frozen'); END;

CREATE TABLE github_deployments (
  workspace_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  deployment_id TEXT NOT NULL CHECK(length(deployment_id) BETWEEN 1 AND 40),
  sha TEXT NOT NULL CHECK(length(sha)=40),
  environment TEXT NOT NULL,
  state TEXT NOT NULL,
  target_url TEXT,
  delivery_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,installation_id,repository_id,deployment_id),
  FOREIGN KEY(workspace_id,installation_id) REFERENCES github_installations(workspace_id,installation_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX github_deployments_lookup ON github_deployments(workspace_id,deployment_id);

CREATE INDEX github_deployments_sha ON github_deployments(workspace_id,repository_id,sha);

CREATE TRIGGER github_deployments_frozen BEFORE UPDATE ON github_deployments WHEN NEW.sha<>OLD.sha OR NEW.repository_id<>OLD.repository_id OR NEW.deployment_id<>OLD.deployment_id BEGIN SELECT RAISE(ABORT,'github_deployment_frozen'); END;

CREATE TABLE github_checks (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  head_sha TEXT NOT NULL CHECK(length(head_sha)=40),
  name TEXT NOT NULL CHECK(name IN ('TestMaster / result','TestMaster / required-gate')),
  external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','in_progress','completed')),
  conclusion TEXT CHECK(conclusion IS NULL OR conclusion IN ('success','failure','neutral','cancelled','action_required')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_url TEXT,
  seq INTEGER NOT NULL CHECK(seq>=0),
  delivered_seq INTEGER NOT NULL DEFAULT -1 CHECK(delivered_seq>=-1),
  remote_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','delivered','rate_limited','permission_revoked','host_unavailable','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  first_failed_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,pull_id,name),
  CHECK((status='completed')=(conclusion IS NOT NULL)),
  CHECK(delivered_seq<=seq),
  FOREIGN KEY(workspace_id,pull_id) REFERENCES github_pulls(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX github_checks_due ON github_checks(workspace_id,state,next_attempt_at);

CREATE TRIGGER github_checks_frozen BEFORE UPDATE ON github_checks WHEN NEW.id<>OLD.id OR NEW.pull_id<>OLD.pull_id OR NEW.head_sha<>OLD.head_sha OR NEW.name<>OLD.name OR NEW.external_id<>OLD.external_id OR NEW.full_name<>OLD.full_name OR NEW.seq<OLD.seq OR NEW.delivered_seq<OLD.delivered_seq OR (OLD.status='completed' AND (NEW.status<>'completed' OR NEW.conclusion IS NOT OLD.conclusion)) BEGIN SELECT RAISE(ABORT,'github_check_frozen'); END;
