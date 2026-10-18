{context}

The TestMaster workspace of this directory is already initialized (`testmaster init --base-url {targetUrl}`); the `testmaster` skill describes how to work with TestMaster.

Task: use TestMaster to create a verified automated test of this behavior:

{task}

The task is done when the test exists in TestMaster and its active revision ran against {targetUrl} with outcome passed and gate passed. If the product does not behave as described, a failing run that you diagnosed is a valid result: never weaken an assertion to turn a test green.

Rules:
- You have full autonomy. Nobody will answer questions or give approvals: decide every review yourself (requirements, conflicts, plan acceptance, promotion, healing) and record your reason. Do not stop to ask.
- Do not change the product code. Do not change, move or delete anything outside this directory.
- For model calls made by TestMaster use provider `{internalProvider}`, model `{internalModel}`.
- Never put a secret value on a command line or in a tool argument.{secretsNote}

End with a short summary: the test id, the run id of its last run, and that run's outcome and gate.
