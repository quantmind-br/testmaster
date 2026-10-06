ALTER TABLE consents ADD COLUMN allow_unknown_cost INTEGER NOT NULL DEFAULT 0 CHECK(allow_unknown_cost IN (0,1));
ALTER TABLE budget_reservations ADD COLUMN reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0);
ALTER TABLE budget_reservations ADD COLUMN charged_tokens BIGINT CHECK(charged_tokens>=0);
CREATE TABLE token_budget_limits (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tokens BIGINT NOT NULL CHECK(tokens>=0),
  PRIMARY KEY(workspace_id,project_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);
