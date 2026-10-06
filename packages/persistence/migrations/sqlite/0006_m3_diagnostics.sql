CREATE UNIQUE INDEX runs_test_identity ON runs(workspace_id,id,test_id);

CREATE UNIQUE INDEX snapshots_run_identity ON snapshots(workspace_id,id,run_id);

CREATE TABLE analyses (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  run_id TEXT NOT NULL, snapshot_id TEXT, parent_id TEXT, model_call_id TEXT, source TEXT NOT NULL CHECK(source IN ('rules','model')), failure_kind TEXT NOT NULL CHECK(failure_kind IN ('product_bug','test_fragility','environment','contract_violation','security_policy','unknown')),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,snapshot_id) REFERENCES snapshots(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,snapshot_id,run_id) REFERENCES snapshots(workspace_id,id,run_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,parent_id) REFERENCES analyses(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,parent_id,run_id) REFERENCES analyses(workspace_id,id,run_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,model_call_id) REFERENCES model_calls(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,id,run_id),
  CHECK(source='model' OR (parent_id IS NULL AND model_call_id IS NULL)),
  CHECK(source='rules' OR parent_id IS NOT NULL),
  CHECK(json_extract(data_json,'$.id') IS NULL OR json_extract(data_json,'$.id')=id),
  CHECK(json_extract(data_json,'$.runId') IS NULL OR json_extract(data_json,'$.runId')=run_id)
) STRICT;

CREATE INDEX analyses_run_history ON analyses(workspace_id,run_id,created_at DESC,id DESC);

CREATE TRIGGER analyses_no_update BEFORE UPDATE ON analyses BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TRIGGER analyses_no_delete BEFORE DELETE ON analyses BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TABLE healing_proposals (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  failed_run_id TEXT NOT NULL, test_id TEXT NOT NULL, analysis_id TEXT, base_revision_id TEXT NOT NULL, candidate_revision_id TEXT NOT NULL, risk TEXT NOT NULL CHECK(risk IN ('read','write','destructive','securityProbe')), status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','verified')), approval_mode TEXT CHECK(approval_mode IS NULL OR approval_mode IN ('manual','policy')), reviewer_id TEXT, verification_run_id TEXT,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,failed_run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,failed_run_id,test_id) REFERENCES runs(workspace_id,id,test_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,test_id) REFERENCES tests(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,base_revision_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,base_revision_id,test_id) REFERENCES test_revisions(workspace_id,id,test_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,candidate_revision_id) REFERENCES test_revisions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,candidate_revision_id,test_id) REFERENCES test_revisions(workspace_id,id,test_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,analysis_id) REFERENCES analyses(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,analysis_id,failed_run_id) REFERENCES analyses(workspace_id,id,run_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,reviewer_id) REFERENCES principals(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,verification_run_id) REFERENCES runs(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,verification_run_id,test_id) REFERENCES runs(workspace_id,id,test_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,failed_run_id),
  UNIQUE(workspace_id,candidate_revision_id),
  CHECK(verification_run_id IS NULL OR verification_run_id<>failed_run_id),
  CHECK(status NOT IN ('approved','verified') OR approval_mode IS NOT NULL),
  CHECK(status<>'verified' OR verification_run_id IS NOT NULL),
  CHECK(approval_mode IS NULL OR approval_mode<>'manual' OR reviewer_id IS NOT NULL),
  CHECK(json_extract(data_json,'$.id') IS NULL OR json_extract(data_json,'$.id')=id),
  CHECK(json_extract(data_json,'$.failedRunId') IS NULL OR json_extract(data_json,'$.failedRunId')=failed_run_id),
  CHECK(json_extract(data_json,'$.candidateRevisionId') IS NULL OR json_extract(data_json,'$.candidateRevisionId')=candidate_revision_id)
) STRICT;

CREATE INDEX healing_proposals_test ON healing_proposals(workspace_id,test_id,created_at DESC,id DESC);

CREATE UNIQUE INDEX healing_proposals_verification ON healing_proposals(workspace_id,verification_run_id) WHERE verification_run_id IS NOT NULL;

CREATE TRIGGER healing_proposals_frozen BEFORE UPDATE ON healing_proposals WHEN NEW.failed_run_id<>OLD.failed_run_id OR NEW.test_id<>OLD.test_id OR NEW.base_revision_id<>OLD.base_revision_id OR NEW.candidate_revision_id<>OLD.candidate_revision_id OR NEW.risk<>OLD.risk OR OLD.status IN ('rejected','verified') OR (OLD.verification_run_id IS NOT NULL AND (NEW.verification_run_id IS NULL OR NEW.verification_run_id<>OLD.verification_run_id)) OR NEW.version<>OLD.version+1 BEGIN SELECT RAISE(ABORT,'healing_proposal_frozen'); END;

CREATE TRIGGER healing_proposals_no_delete BEFORE DELETE ON healing_proposals BEGIN SELECT RAISE(ABORT,'immutable'); END;

CREATE TABLE deliveries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
  event_id TEXT NOT NULL, destination_ref TEXT NOT NULL, check_name TEXT NOT NULL CHECK(check_name IN ('TestMaster / result','TestMaster / required-gate')), subject_sha TEXT NOT NULL CHECK(length(subject_sha)=40), report_hash TEXT NOT NULL CHECK(length(report_hash)=64), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64), batch_id TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at TEXT, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), check_status TEXT NOT NULL CHECK(check_status IN ('in_progress','completed')), external_id TEXT,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,event_id) REFERENCES outbox(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,batch_id) REFERENCES batches(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(workspace_id,destination_ref,subject_sha,report_hash,check_name),
  CHECK(json_extract(data_json,'$.id') IS NULL OR json_extract(data_json,'$.id')=id),
  CHECK(json_extract(data_json,'$.subjectSha') IS NULL OR json_extract(data_json,'$.subjectSha')=subject_sha)
) STRICT;

CREATE INDEX deliveries_pending ON deliveries(workspace_id,state,next_attempt_at);

CREATE TRIGGER deliveries_frozen_subject BEFORE UPDATE ON deliveries WHEN NEW.destination_ref<>OLD.destination_ref OR NEW.subject_sha<>OLD.subject_sha OR NEW.report_hash<>OLD.report_hash OR NEW.check_name<>OLD.check_name OR NEW.payload_hash<>OLD.payload_hash OR NEW.event_id<>OLD.event_id OR (OLD.external_id IS NOT NULL AND (NEW.external_id IS NULL OR NEW.external_id<>OLD.external_id)) OR OLD.state IN ('delivered','dead_letter') BEGIN SELECT RAISE(ABORT,'delivery_subject_frozen'); END;

CREATE TRIGGER deliveries_no_delete BEFORE DELETE ON deliveries BEGIN SELECT RAISE(ABORT,'immutable'); END;
