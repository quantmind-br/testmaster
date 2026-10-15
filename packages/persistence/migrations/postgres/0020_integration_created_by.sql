-- Scope consent is gone: an integration keeps the principal accountable for it as `createdBy` and no longer stores a consent record.
-- `createdBy` is the principal the integration acted as. It resolves, in order, from a nonempty string `createdBy`, the recorded
-- consent grantor, and the actor of the integration's creation audit event. No other value is ever invented: when any integration
-- cannot resolve a nonempty principal this migration raises, its transaction rolls back and the schema stays at the previous version.
-- Lifecycle state is untouched: a revoked integration stays revoked and paused stays paused.

SELECT set_config('testmaster.workspace', '*', true);

CREATE TEMP TABLE integration_created_by_owner ON COMMIT DROP AS
SELECT
  i.workspace_id AS workspace_id,
  i.id AS id,
  CASE WHEN jsonb_typeof(j.d)='object' THEN COALESCE(
    CASE WHEN jsonb_typeof(j.d->'createdBy')='string' AND btrim(j.d->>'createdBy')<>'' THEN j.d->>'createdBy' END,
    CASE WHEN jsonb_typeof(j.d #> '{consent,grantedBy}')='string' AND btrim(j.d #>> '{consent,grantedBy}')<>'' THEN j.d #>> '{consent,grantedBy}' END,
    (SELECT a.actor FROM audit_events a WHERE a.workspace_id=i.workspace_id AND a.action='integrations.create' AND a.resource_id=i.id AND btrim(a.actor)<>'' ORDER BY a.created_at,a.id LIMIT 1)
  ) END AS owner
FROM integrations i
CROSS JOIN LATERAL (SELECT i.data_json::jsonb AS d) j;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM integration_created_by_owner WHERE owner IS NULL) THEN
    RAISE EXCEPTION 'integration_created_by_unresolvable: an integration has no recorded creator, consent grantor or creation audit actor' USING ERRCODE='23514';
  END IF;
END $$;

UPDATE integrations i
SET data_json=((i.data_json::jsonb - 'consent') || jsonb_build_object('createdBy', o.owner))::text
FROM integration_created_by_owner o
WHERE o.workspace_id=i.workspace_id AND o.id=i.id;
