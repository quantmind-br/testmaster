# c0-reference-shop: outcome

The round stopped because the provider refused the agent model. It is **invalid as calibration**, and
its numbers are not evidence for any arm.

- At 2026-10-18T19:43 UTC QuantForge started answering every `qwen3.8-flash` request with HTTP 429
  `model_cooldown`: "insufficient_quota: Your token-plan 1-month quota has been exhausted. The quota
  will reset at 11-06 16:00:00 UTC". The response carried `retry-after-ms=1628186000`. A direct probe
  right after the round got the same refusal. In the same probe, `muse-spark-1.3-contributor` and
  `gpt-6.1-sol` answered.
- 3 of the 20 sessions ended normally before the refusal: rs-paging A0, rs-paging A1 and
  rs-password A3.
- 4 sessions were cut mid-way by the 429: rs-password A0, rs-price A0, rs-product-update A1 and
  rs-product-update A3.
- The other 13 sessions got the 429 on their first request and made no TestMaster call.
- `sessions.ndjson`, `report.md` and `analysis.json` are kept as written by the driver, unedited.
  Their per-arm aggregates mix provider failures with results, so do not read them as arm
  comparisons.

Observations for the instrument, from the sessions that ran:

- The complete sessions used between 2.5 M and 26 M prompt tokens each (Ttotal, cache included).
  rs-price A0 made 242 model requests, its largest request being 753 KB. That volume is what
  exhausted the monthly quota.
- rs-password A0 recorded a false positive: a test green on its active revision failed on the clean
  target during the fidelity replay.

Stop rule (protocol `stopRules.midRound`): the provider is down for a whole round, so no
further round of the preregistered model pair can run until the quota resets
(2026-11-06 16:00 UTC) or the operator changes the model registration.
