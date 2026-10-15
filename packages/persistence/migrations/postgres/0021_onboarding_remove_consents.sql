-- Setup-wizard choices no longer carry scan/load/security/tunnel consents. Stored wizard state
-- (operational_state key onboarding:<workspace>:<project>:<principal>) keeps every other field,
-- including its version and its history; only choices.consents is removed so the stored value
-- satisfies the current OnboardingChoices schema.
UPDATE operational_state
SET value=(value::jsonb #- '{choices,consents}')::text
WHERE key LIKE 'onboarding:%'
  AND jsonb_typeof(value::jsonb)='object'
  AND jsonb_typeof(value::jsonb->'choices')='object'
  AND (value::jsonb->'choices') ? 'consents';
