-- Setup-wizard choices no longer carry scan/load/security/tunnel consents. Stored wizard state
-- (operational_state key onboarding:<workspace>:<project>:<principal>) keeps every other field,
-- including its version and its history; only choices.consents is removed so the stored value
-- satisfies the current OnboardingChoices schema.
UPDATE operational_state
SET value=json_remove(value,'$.choices.consents')
WHERE key LIKE 'onboarding:%'
  AND json_valid(value)
  AND json_type(value)='object'
  AND json_type(value,'$.choices')='object'
  AND json_type(value,'$.choices.consents') IS NOT NULL;
