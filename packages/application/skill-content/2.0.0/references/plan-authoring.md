# Plan authoring

Start from a valid example, never from memory. The plan is the `ExecutablePlan` contract:

```sh
testmaster test create --example --type backend --output json | jq '.data.fixture.input.content' > plan.json
testmaster test lint --plan plan.json --output json
```

`--type` is `backend` (http runner), `frontend` (playwright) or `cli` (terminal). Lint is offline: `data.validated` is true, or `error.details.issues[]` lists `path` (JSON pointer), `rule`, `message`. Then `testmaster test create --plan plan.json`, `testmaster plan edit PRO_ID --plan plan.json --expected-version N`, or `test revision create`; all validate the same way.

## Shape

Top level: `schemaVersion "1.0.0"`, `kind "executable"`, `name`, `type`, `runner`, `requirementRefs` (req_ IDs from `requirement list`), `steps`, optional `cleanup`. A step `id` matches `^[a-z][a-z0-9_-]{0,63}$`; never rename one a result cites. Values are `{"literal": X}`, `{"secretRef": "SEC_ID"}` (`data.id` of `secret set`) or `{"variableRef": "step.capture"}`; a JSON body is `{"kind":"json","value":{"literal":{...}}}`. An assertion on a response names it: `"input":{"responseStepId":"create-item"}`.

## Schema without flooding stdout

The schema is about 250 KB. Never print it; write it once and query it:

```sh
testmaster contract schema ExecutablePlan --out .testmaster/ExecutablePlan.schema.json
jq -r '[.. | objects | .properties.predicate.const? // empty] | unique | join(",")' .testmaster/ExecutablePlan.schema.json
jq -r '[.. | objects | .properties.operation.const? // empty] | unique | join(",")' .testmaster/ExecutablePlan.schema.json
```

`--out` refuses an existing file.

## Cleanup of created data

A plan that creates data must delete it. The creating request declares how the runner proves the data is its own, and a `cleanup` entry names that step:

```json
{"id":"create-item","kind":"action","operation":"request","description":"Create","required":true,
 "input":{"method":"POST","pathSegments":[{"literal":"api"},{"literal":"items"}],
  "body":{"kind":"json","value":{"literal":{"name":"tm-run-item"}}},
  "resource":{"resourceType":"item","correlationKey":{"literal":"tm-run-item"},"handle":"/id","ownerProof":"/ownerId"}},"timeoutMs":30000}
"cleanup":[{"resourceRef":"create-item","operation":"request","input":{"method":"DELETE",
 "pathSegments":[{"literal":"api"},{"literal":"items"},{"variableRef":"create-item.handle"}]},
 "successPredicate":{"predicate":"statusIn","values":[200,204,404]},"deadlineMs":30000,"required":true}]
```

`handle` and `ownerProof` are JSON pointers into the creation response (the new id; a creator or tenant id). Without both, the runner never runs the cleanup, the data is left orphaned and the gate fails: validation refuses it as `cleanup_never_runs` (`error.details.reasonCode`). Add 404 to `successPredicate` in case a step already deleted it.

Data a browser step creates has no creating request, so the entry carries `find` and `resourceRef` is the creating step's id (`submit-project`):

```json
"find":{"resourceType":"project","lookup":{"method":"GET","pathSegments":[{"literal":"api"},{"literal":"projects"}],"auth":"profile"},
 "itemsPointer":"/items","keyPointer":"/name","equals":{"literal":"tm-run-project"},
 "handlePointer":"/id","ownerProofPointer":"/ownerId","totalPointer":"/total"}
```

The lookup is a GET with no body. It deletes only when exactly one item has `keyPointer` equal to `equals` and carries both pointers. No match passes; two or more fail and delete nothing; a paged list (`totalPointer` above the items, or `Link rel=next`) is inconclusive. Give the data a name unique to the run. `equals` is never a secret.

## `jsonSchema` vs `jsonConforms`

`jsonSchema` cites a source: `{"predicate":"jsonSchema","sourceRevisionId":"svr_...","pointer":"/paths/~1items/get/responses/200/content/application~1json/schema"}`; `sourceRevisionId` is `data.revision.id` of `source add`, and it checks only what that schema declares (an untyped field passes). `jsonConforms` carries its own draft 2020-12 schema, written from the approved criteria, never copied from a response: `{"predicate":"jsonConforms","schema":{"type":"object","required":["id"],"properties":{"id":{"type":"integer","minimum":1}}}}`. Use it for types, bounds, required fields and list item shape.

## Locators

A locator matching several elements fails as ambiguous: narrow it by name, label or container. Use `nth` (0-based) only for the n-th of identical siblings.
