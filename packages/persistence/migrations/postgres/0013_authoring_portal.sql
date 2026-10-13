-- M4 authoring portal (S4b): per-principal test drafts (UX-023) and refinement chat turns (REQ-054).
-- A draft is never a TestRevision: publishing it goes through the revision route, so the executed history stays immutable.
-- Both tables carry workspace_id, so they enable the ADR-015 tenant_isolation policy through tm_enable_tenant_rls (0011).

CREATE TABLE test_drafts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK(version>=1),
  project_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK(length(content_json)<=1048576),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,test_id,principal_id)
);

ALTER TABLE test_drafts ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

-- One row per chat message. subject_kind/subject_id name the proposal or test being refined; proposal_id is the
-- proposal an assistant turn produced. Turns may be deleted with their project, never edited.
CREATE TABLE refinement_turns (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('proposal','test')),
  subject_id TEXT NOT NULL,
  seq BIGINT NOT NULL CHECK(seq>=1),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  principal_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 8000),
  proposal_id TEXT,
  model_call_id TEXT,
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,subject_kind,subject_id,seq)
);

ALTER TABLE refinement_turns ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION protect_refinement_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refinement_turn_frozen' USING ERRCODE='23514'; END $$;

CREATE TRIGGER refinement_turns_append_only BEFORE UPDATE ON refinement_turns FOR EACH ROW EXECUTE FUNCTION protect_refinement_turn();

SELECT tm_enable_tenant_rls('test_drafts');

SELECT tm_enable_tenant_rls('refinement_turns');
