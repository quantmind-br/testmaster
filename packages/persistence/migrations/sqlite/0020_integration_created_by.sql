-- Scope consent is gone: an integration keeps the principal accountable for it as `createdBy` and no longer stores a consent record.
-- `createdBy` is the principal the integration acted as. It resolves, in order, from a nonempty text `createdBy`, the recorded
-- consent grantor, and the actor of the integration's creation audit event. No other value is ever invented: when any integration
-- cannot resolve a nonempty principal this migration aborts, rolls back and leaves the database at the previous version.
-- Lifecycle state is untouched: a revoked integration stays revoked and paused stays paused.

CREATE TEMP TABLE integration_created_by_owner AS
SELECT
  i.workspace_id AS workspace_id,
  i.id AS id,
  CASE WHEN json_valid(i.data_json) AND json_type(i.data_json)='object' THEN COALESCE(
    CASE WHEN json_type(i.data_json,'$.createdBy')='text' AND trim(json_extract(i.data_json,'$.createdBy'))<>'' THEN json_extract(i.data_json,'$.createdBy') END,
    CASE WHEN json_type(i.data_json,'$.consent.grantedBy')='text' AND trim(json_extract(i.data_json,'$.consent.grantedBy'))<>'' THEN json_extract(i.data_json,'$.consent.grantedBy') END,
    (SELECT a.actor FROM audit_events a WHERE a.workspace_id=i.workspace_id AND a.action='integrations.create' AND a.resource_id=i.id AND trim(a.actor)<>'' ORDER BY a.created_at,a.id LIMIT 1)
  ) END AS owner
FROM integrations i;

CREATE TEMP TABLE integration_created_by_guard(unresolved INTEGER);

CREATE TEMP TRIGGER integration_created_by_unresolvable BEFORE INSERT ON integration_created_by_guard BEGIN SELECT RAISE(ABORT,'integration_created_by_unresolvable: an integration has no recorded creator, consent grantor or creation audit actor'); END;

INSERT INTO integration_created_by_guard(unresolved) SELECT 1 WHERE EXISTS(SELECT 1 FROM integration_created_by_owner WHERE owner IS NULL);

UPDATE integrations
SET data_json=json_remove(
  json_set(
    data_json,
    '$.createdBy',
    (SELECT o.owner FROM integration_created_by_owner o WHERE o.workspace_id=integrations.workspace_id AND o.id=integrations.id)
  ),
  '$.consent'
);

DROP TABLE integration_created_by_guard;

DROP TABLE integration_created_by_owner;
