# Healing

Heal only a fragile test, never a product defect. Start from `testmaster run analyze RUN_ID` (RUN_ID is the failed run): `data.recommendedAction` must be `fix_test`. For `fix_product` fix the application outside TestMaster.

1. `testmaster heal propose RUN_ID` (add `--provider ID --model ID` to pick a model; no deadline, no shell/tool timeout) -> `data.id` (hea_) is HEA_ID. An abstention (`Healing abstained (reasonCode)`, `data.reasonCode`) is a normal result with exit 0: no safe repair exists. Exit 6 refusals before any model call: `healing_not_indicated` (healing replaces locators of action steps only, never an assertion's) and `revision_not_active` (the run replayed a revision other than the test's active one).
   For those, correct the plan and replay it: `testmaster test revision create TEST_ID --plan plan.json` -> `data.id` (rev_) is REV_ID, then `testmaster test run TEST_ID --revision REV_ID --env NAME --wait`.
2. `testmaster heal review HEA_ID` is read-only. Check `data.preservedAssertions.intact` is true (healing never changes assertions; if false, reject), `data.risk` and `data.riskBasis`, the before/after candidates, `data.automation.decision`, and `data.verification` (`runId`, `outcome`, `gate`; null while the verification run has no verdict).
3. Decide yourself:
   `testmaster heal approve HEA_ID --expected-version N --reason TEXT --wait` -> N is `data.approval.expectedVersion` of the review. It creates the candidate revision and a verification run; `--wait` waits for it (no worker needed).
   `testmaster heal reject HEA_ID --reason TEXT` (reason required).

The healed revision becomes active only after its verification run passes. Never promote one whose verification did not pass: read `testmaster heal review HEA_ID` again and `testmaster run get VERIFICATION_RUN_ID` (`data.verification.runId` of the review). CI replays a pinned revision with healing off.
