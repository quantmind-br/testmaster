# Approvals

A production or otherwise risky run is refused at admission with exit 9 (`POLICY_DENIED`), `error.details.reasonCode` = `approval_required`; a run that is admitted but ends `blocked` with that reason exits 15. The error carries `error.details.actions` (steps and risk) and `error.details.binding`:

```json
{"revisionHash":"...","environmentRevisionId":"evr_...","originSet":["https://..."],"actionSet":["..."],"policyHash":"...","actorId":"..."}
```

Copy each value; invent none. Create the approval as the authenticated principal, then repeat the exact same `test run` command:

```sh
testmaster approval create --revision-hash REVISION_HASH --environment-revision EVR_ID \
  --origin ORIGIN --action ACTION --policy-hash POLICY_HASH --actor ACTOR_ID \
  --reason "TEXT, 1-200 characters"
```

- Flags map one to one: `--origin` is repeated per entry of `originSet`, `--action` per entry of `actionSet`, `--actor` is `actorId`.
- It needs the write scope. The approval is bound to that exact revision, environment revision, origins, actions and policy, expires in 30 minutes (`--expires-at` may shorten it) and is single use: a second run needs a second approval. `data.id` (apr_) is the approval.
- `testmaster approval list`, `approval get APR_ID` and `approval revoke APR_ID` inspect or withdraw one.
- If the project policy requires separation of duties, the requester cannot approve its own execution (`reason: separation_of_duties`), and two required approvers need two distinct reviewers. Report the reason and who must approve; do not work around it.
- Other blocked causes (`security_precondition_failed`, `egress_denied`) have no approval: read `testmaster run get RUN_ID` and `run analyze RUN_ID`.
