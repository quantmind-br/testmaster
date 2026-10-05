# M1 quickstart — observed manual transcript

Recorded: 2026-10-05T21:41:00.288Z

Built CLI executed against a real local reference-shop using an isolated repository, HOME and Docker runner. No LLM or external SaaS exercised. Temporary execution directories were removed after capture.

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js init --mode local --name M1 quickstart --base-url http://127.0.0.1:42965 --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_e3dbf3f2-f83e-4394-ad3c-343d27976f13","data":{"workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a","principalId":"usr_01a10e03-3b6b-7382-829a-b1f37108bfe1","projectId":"prj_01a10e03-3b71-7670-a98e-0796caca5893","environmentId":"env_01a10e03-3b72-7325-abf1-b420e78767ca","sessionOnly":false},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js doctor --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_7232ec12-0d74-42f3-a22d-017f44572032","data":{"status":"PASS","checks":{"runtime":{"status":"PASS","available":true,"mode":"rootful","seccomp":true,"cgroupVersion":"2","diagnostics":[]},"images":{"status":"PASS"},"storage":{"status":"PASS","availableBytes":30216368128},"secrets":{"status":"PASS","backend":"secret-tool","writable":true},"config":{"status":"PASS","effectiveConfig":{"config":{"schemaVersion":"1.0.0","project":{"name":"M1 quickstart","id":"prj_01a10e03-3b71-7670-a98e-0796caca5893"},"execution":{"executor":"docker","mode":"replay","concurrency":2,"executionTimeoutMs":1800000,"attemptTimeoutMs":300000,"stepTimeoutMs":30000,"networkRequestTimeoutMs":30000,"preparationTimeoutMs":120000,"collectionGraceMs":60000,"analysisGraceMs":60000,"maxAttempts":2,"bodyBytes":10485760,"artifactBytes":67108864,"attemptArtifactBytes":268435456,"logBytes":10485760},"environment":{"baseUrl":"http://127.0.0.1:3000","networkProfile":"local-loopback","locale":"en-US","timezone":"UTC"},"browser":{"name":"chromium","viewport":{"width":1280,"height":720},"testIdAttributes":["data-testid"]},"healing":{"mode":"off"},"artifacts":{"trace":"off","video":"off","retentionDays":30},"telemetry":{"enabled":false}},"origins":{"schemaVersion":"project","project.name":"project","execution.executor":"project","execution.mode":"project","execution.concurrency":"project","execution.executionTimeoutMs":"project","execution.attemptTimeoutMs":"project","execution.stepTimeoutMs":"project","execution.networkRequestTimeoutMs":"project","execution.preparationTimeoutMs":"project","execution.collectionGraceMs":"project","execution.analysisGraceMs":"project","execution.maxAttempts":"project","execution.bodyBytes":"project","execution.artifactBytes":"project","execution.attemptArtifactBytes":"project","execution.logBytes":"project","environment.baseUrl":"project","environment.networkProfile":"project","environment.locale":"project","environment.timezone":"project","browser.name":"project","browser.viewport.width":"project","browser.viewport.height":"project","browser.testIdAttributes":"project","healing.mode":"environment","artifacts.trace":"project","artifacts.video":"project","artifacts.retentionDays":"project","telemetry.enabled":"environment","project.id":"project"},"policyHash":"fef0a2391582cede3a7173e850e57448bd9c8360e062312a65e5be6df67ad0d3"}},"target":{"status":"NOT_CHECKED"},"model":{"status":"DISABLED","reason":"No model calls in replay"}}},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js test lint --plan health.plan.json --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_df6c3a42-32db-4a0f-a3d4-cb3ef4a270a7","data":{"validated":true,"plan":{"schemaVersion":"1.0.0","kind":"executable","name":"Reference shop HTTP health","type":"backend","runner":"http","requirementRefs":[],"steps":[{"id":"health","description":"Read the real service health","kind":"action","operation":"request","input":{"method":"GET","pathSegments":[{"literal":"health"}]},"required":true,"timeoutMs":30000},{"id":"status","description":"HTTP 200","kind":"assertion","operation":"assert","input":{"responseStepId":"health"},"expectation":{"predicate":"statusIn","values":[200]},"required":true,"timeoutMs":30000},{"id":"body","description":"Healthy service state","kind":"assertion","operation":"assert","input":{"responseStepId":"health","jsonPointer":"/status"},"expectation":{"predicate":"jsonEquals","value":{"literal":"ok"}},"required":true,"timeoutMs":30000}],"dependsOn":[],"cleanup":[],"tags":[],"priority":"normal"}},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js test create --plan health.plan.json --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_d569a3d8-9424-4ec1-8c04-9cd9e06f8dc0","data":{"id":"tst_01a10e03-3ffa-763d-9397-0d7793b68742","workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a","createdAt":"2026-10-05T21:40:56.442Z","version":2,"projectId":"prj_01a10e03-3b71-7670-a98e-0796caca5893","name":"Reference shop HTTP health","activeRevisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","tags":[],"priority":"normal","archivedAt":null},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js test run tst_01a10e03-3ffa-763d-9397-0d7793b68742 --wait --timeout 180 --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_982889a1-ae2b-4af2-a061-c59e23d62ef6","data":{"receipt":{"runId":"run_01a10e03-4287-7777-908a-75aa8cbbef1b","status":"queued","revisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","environmentRevisionId":"evr_01a10e03-3b72-7325-abf1-b329752b06ea","acceptedAt":"2026-10-05T21:40:57.096Z","links":{"self":"/v1/runs/run_01a10e03-4287-7777-908a-75aa8cbbef1b","events":"/v1/runs/run_01a10e03-4287-7777-908a-75aa8cbbef1b/events","bundle":"/v1/runs/run_01a10e03-4287-7777-908a-75aa8cbbef1b/bundle"},"idempotencyKey":"27637db4-4b5b-45bb-aa8d-fb6b2490a670","ownership":"ephemeral"},"run":{"analysisStatus":"not_requested","batchId":null,"cleanupOutcome":"not_required","createdAt":"2026-10-05T21:40:57.096Z","environmentRevisionId":"evr_01a10e03-3b72-7325-abf1-b329752b06ea","gate":"passed","gatePolicy":{"cleanupRequired":false,"executor":"docker","ownership":"ephemeral","policyHash":"fef0a2391582cede3a7173e850e57448bd9c8360e062312a65e5be6df67ad0d3","policySatisfied":true,"requiredDependenciesPassed":true,"requiredEvidenceComplete":true},"id":"run_01a10e03-4287-7777-908a-75aa8cbbef1b","matrixCell":{"baseUrl":"http://127.0.0.1:42965","effectiveConfig":{"config":{"artifacts":{"retentionDays":30,"trace":"off","video":"off"},"browser":{"name":"chromium","testIdAttributes":["data-testid"],"viewport":{"height":720,"width":1280}},"environment":{"baseUrl":"http://127.0.0.1:3000","locale":"en-US","networkProfile":"local-loopback","timezone":"UTC"},"execution":{"analysisGraceMs":60000,"artifactBytes":67108864,"attemptArtifactBytes":268435456,"attemptTimeoutMs":300000,"bodyBytes":10485760,"collectionGraceMs":60000,"concurrency":2,"executionTimeoutMs":1800000,"executor":"docker","logBytes":10485760,"maxAttempts":2,"mode":"replay","networkRequestTimeoutMs":30000,"preparationTimeoutMs":120000,"stepTimeoutMs":30000},"healing":{"mode":"off"},"project":{"id":"prj_01a10e03-3b71-7670-a98e-0796caca5893","name":"M1 quickstart"},"schemaVersion":"1.0.0","telemetry":{"enabled":false}},"origins":{"artifacts.retentionDays":"project","artifacts.trace":"project","artifacts.video":"project","browser.name":"project","browser.testIdAttributes":"project","browser.viewport.height":"project","browser.viewport.width":"project","environment.baseUrl":"project","environment.locale":"project","environment.networkProfile":"project","environment.timezone":"project","execution.analysisGraceMs":"project","execution.artifactBytes":"project","execution.attemptArtifactBytes":"project","execution.attemptTimeoutMs":"project","execution.bodyBytes":"project","execution.collectionGraceMs":"project","execution.concurrency":"project","execution.executionTimeoutMs":"project","execution.executor":"project","execution.logBytes":"project","execution.maxAttempts":"project","execution.mode":"project","execution.networkRequestTimeoutMs":"project","execution.preparationTimeoutMs":"project","execution.stepTimeoutMs":"project","healing.mode":"environment","project.id":"project","project.name":"project","schemaVersion":"project","telemetry.enabled":"environment"},"policyHash":"fef0a2391582cede3a7173e850e57448bd9c8360e062312a65e5be6df67ad0d3"},"environmentId":"env_01a10e03-3b72-7325-abf1-b420e78767ca","environmentName":"local","executor":"docker","limits":{"analysisGraceMs":60000,"artifactBytes":67108864,"attemptArtifactBytes":268435456,"attemptTimeoutMs":300000,"bodyBytes":10485760,"collectionGraceMs":60000,"executionTimeoutMs":1800000,"logBytes":10485760,"maxAttempts":2,"networkRequestTimeoutMs":30000,"preparationTimeoutMs":120000,"stepTimeoutMs":30000},"maxConcurrency":2,"ownership":"ephemeral","planHash":"609fbcaa59c27e7595c233d135eee02774dd2fffebc9b5e16fd4d0781697a886","seed":0},"mode":"replay","origin":"cli","outcome":"passed","phase":"completed","revisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","status":"passed","testId":"tst_01a10e03-3ffa-763d-9397-0d7793b68742","version":2,"workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"}},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js run get run_01a10e03-4287-7777-908a-75aa8cbbef1b --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_7545f1eb-29e5-43d3-994e-e6b094a63b5c","data":{"analysisStatus":"not_requested","batchId":null,"cleanupOutcome":"not_required","createdAt":"2026-10-05T21:40:57.096Z","environmentRevisionId":"evr_01a10e03-3b72-7325-abf1-b329752b06ea","gate":"passed","gatePolicy":{"cleanupRequired":false,"executor":"docker","ownership":"ephemeral","policyHash":"fef0a2391582cede3a7173e850e57448bd9c8360e062312a65e5be6df67ad0d3","policySatisfied":true,"requiredDependenciesPassed":true,"requiredEvidenceComplete":true},"id":"run_01a10e03-4287-7777-908a-75aa8cbbef1b","matrixCell":{"baseUrl":"http://127.0.0.1:42965","effectiveConfig":{"config":{"artifacts":{"retentionDays":30,"trace":"off","video":"off"},"browser":{"name":"chromium","testIdAttributes":["data-testid"],"viewport":{"height":720,"width":1280}},"environment":{"baseUrl":"http://127.0.0.1:3000","locale":"en-US","networkProfile":"local-loopback","timezone":"UTC"},"execution":{"analysisGraceMs":60000,"artifactBytes":67108864,"attemptArtifactBytes":268435456,"attemptTimeoutMs":300000,"bodyBytes":10485760,"collectionGraceMs":60000,"concurrency":2,"executionTimeoutMs":1800000,"executor":"docker","logBytes":10485760,"maxAttempts":2,"mode":"replay","networkRequestTimeoutMs":30000,"preparationTimeoutMs":120000,"stepTimeoutMs":30000},"healing":{"mode":"off"},"project":{"id":"prj_01a10e03-3b71-7670-a98e-0796caca5893","name":"M1 quickstart"},"schemaVersion":"1.0.0","telemetry":{"enabled":false}},"origins":{"artifacts.retentionDays":"project","artifacts.trace":"project","artifacts.video":"project","browser.name":"project","browser.testIdAttributes":"project","browser.viewport.height":"project","browser.viewport.width":"project","environment.baseUrl":"project","environment.locale":"project","environment.networkProfile":"project","environment.timezone":"project","execution.analysisGraceMs":"project","execution.artifactBytes":"project","execution.attemptArtifactBytes":"project","execution.attemptTimeoutMs":"project","execution.bodyBytes":"project","execution.collectionGraceMs":"project","execution.concurrency":"project","execution.executionTimeoutMs":"project","execution.executor":"project","execution.logBytes":"project","execution.maxAttempts":"project","execution.mode":"project","execution.networkRequestTimeoutMs":"project","execution.preparationTimeoutMs":"project","execution.stepTimeoutMs":"project","healing.mode":"environment","project.id":"project","project.name":"project","schemaVersion":"project","telemetry.enabled":"environment"},"policyHash":"fef0a2391582cede3a7173e850e57448bd9c8360e062312a65e5be6df67ad0d3"},"environmentId":"env_01a10e03-3b72-7325-abf1-b420e78767ca","environmentName":"local","executor":"docker","limits":{"analysisGraceMs":60000,"artifactBytes":67108864,"attemptArtifactBytes":268435456,"attemptTimeoutMs":300000,"bodyBytes":10485760,"collectionGraceMs":60000,"executionTimeoutMs":1800000,"logBytes":10485760,"maxAttempts":2,"networkRequestTimeoutMs":30000,"preparationTimeoutMs":120000,"stepTimeoutMs":30000},"maxConcurrency":2,"ownership":"ephemeral","planHash":"609fbcaa59c27e7595c233d135eee02774dd2fffebc9b5e16fd4d0781697a886","seed":0},"mode":"replay","origin":"cli","outcome":"passed","phase":"completed","revisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","status":"passed","testId":"tst_01a10e03-3ffa-763d-9397-0d7793b68742","version":2,"workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js artifact get run_01a10e03-4287-7777-908a-75aa8cbbef1b --out /tmp/testmaster-quickstart-nf2Z91/repo/evidence --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_de6bcc41-5f71-422b-b79e-20b8989c70e0","data":{"bundleDir":"/tmp/testmaster-quickstart-nf2Z91/repo/evidence","sourceBundleDir":"/tmp/testmaster-quickstart-nf2Z91/repo/.testmaster/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911","manifest":{"attemptId":"att_01a10e03-429d-720a-9e5b-cbbf49bfd911","entries":[{"artifactId":"art_01a10e03-4518-72c9-b98c-833b879442c4","kind":"http","mimeType":"application/json","redactionStatus":"redacted","relativePath":"http/health.json","sha256":"9454b66821c4ea20d08f57ddd14c4c26a4f830e330f5a64c00b490344f4e2ad5","sizeBytes":351,"state":"available"},{"artifactId":"art_01a10e03-4572-7382-947d-8d29dc710c46","kind":"log","mimeType":"text/plain","redactionStatus":"redacted","relativePath":"logs/container.log","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sizeBytes":0,"state":"available"},{"artifactId":"art_01a10e03-4572-7382-947d-91a7c2b12d6d","kind":"snapshot","mimeType":"application/json","redactionStatus":"redacted","relativePath":"snapshot/runtime.json","sha256":"492b08b7e20de160d174eae8c927ae36491b3a8356c1563625b5b07d9b77f3fb","sizeBytes":11719,"state":"available"},{"artifactId":"art_01a10e03-4572-7382-947d-944086bffe37","kind":"network","mimeType":"application/x-ndjson","redactionStatus":"redacted","relativePath":"logs/egress.ndjson","sha256":"9c1c5aa146219b7fc6b752c9a8d0fd155ce9f42dcdfeb83d71746994f2977714","sizeBytes":97,"state":"available"}],"revisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","runId":"run_01a10e03-4287-7777-908a-75aa8cbbef1b","schemaVersion":"1.0.0","snapshotId":"snp_01a10e03-42a8-7786-a66f-7b4a77c6e54e","workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"},"meta":{"attemptId":"att_01a10e03-429d-720a-9e5b-cbbf49bfd911","committedAt":"2026-10-05T21:40:57.845Z","manifestHash":"fc58996ef8c5414cb7ad97f3826d2177ce29df6c0f6889ecfcef8cde0f25e61b","redactionPolicyHash":"cb1d808ce5684a46b66c6fda7c3cdddc40b7492245de7f1fee8012046c851942","revisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","runId":"run_01a10e03-4287-7777-908a-75aa8cbbef1b","schemaVersion":"1.0.0","snapshotId":"snp_01a10e03-42a8-7786-a66f-7b4a77c6e54e","workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"}},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js report export run_01a10e03-4287-7777-908a-75aa8cbbef1b --format json --out /tmp/testmaster-quickstart-nf2Z91/repo/report.json --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_04f492bf-d9ad-43c8-9778-c59298906436","data":{"runId":"run_01a10e03-4287-7777-908a-75aa8cbbef1b","format":"json","out":"/tmp/testmaster-quickstart-nf2Z91/repo/report.json","snapshotId":"snp_01a10e03-42a8-7786-a66f-7b4a77c6e54e"},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js backup create --out /tmp/testmaster-quickstart-nf2Z91/backup --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_d9352f49-2bc9-4d4b-b2a5-b952617fed23","data":{"schemaVersion":"1.0.0","createdAt":"2026-10-05T21:40:58.472Z","files":[{"relativePath":"testmaster.db","sizeBytes":659456,"sha256":"fdd6d914925ad85445d31b18861486f491756bee33daa3566712b99e16a7d74e"},{"relativePath":"evidence-index.json","sizeBytes":2308,"sha256":"4639b5397c112f973fa2296f32b6027c3595ad4e635afd69bbbb651728d5c7fe"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/http/health.json","sizeBytes":351,"sha256":"9454b66821c4ea20d08f57ddd14c4c26a4f830e330f5a64c00b490344f4e2ad5"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/logs/container.log","sizeBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/snapshot/runtime.json","sizeBytes":11719,"sha256":"492b08b7e20de160d174eae8c927ae36491b3a8356c1563625b5b07d9b77f3fb"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/logs/egress.ndjson","sizeBytes":97,"sha256":"9c1c5aa146219b7fc6b752c9a8d0fd155ce9f42dcdfeb83d71746994f2977714"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/manifest.json","sizeBytes":1431,"sha256":"fc58996ef8c5414cb7ad97f3826d2177ce29df6c0f6889ecfcef8cde0f25e61b"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/meta.json","sizeBytes":511,"sha256":"c76b337964aa88c65a6450108bd479a826836d81dd75ba0cdc06cdc0fc0efcf0"}],"databaseVersion":1,"secretIncluded":false},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js backup restore /tmp/testmaster-quickstart-nf2Z91/backup --out /tmp/testmaster-quickstart-nf2Z91/restore --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_1473032d-391d-43d1-b0b7-b71ec02fd497","data":{"out":"/tmp/testmaster-quickstart-nf2Z91/restore","manifest":{"schemaVersion":"1.0.0","createdAt":"2026-10-05T21:40:58.472Z","files":[{"relativePath":"testmaster.db","sizeBytes":659456,"sha256":"fdd6d914925ad85445d31b18861486f491756bee33daa3566712b99e16a7d74e"},{"relativePath":"evidence-index.json","sizeBytes":2308,"sha256":"4639b5397c112f973fa2296f32b6027c3595ad4e635afd69bbbb651728d5c7fe"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/http/health.json","sizeBytes":351,"sha256":"9454b66821c4ea20d08f57ddd14c4c26a4f830e330f5a64c00b490344f4e2ad5"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/logs/container.log","sizeBytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/snapshot/runtime.json","sizeBytes":11719,"sha256":"492b08b7e20de160d174eae8c927ae36491b3a8356c1563625b5b07d9b77f3fb"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/logs/egress.ndjson","sizeBytes":97,"sha256":"9c1c5aa146219b7fc6b752c9a8d0fd155ce9f42dcdfeb83d71746994f2977714"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/manifest.json","sizeBytes":1431,"sha256":"fc58996ef8c5414cb7ad97f3826d2177ce29df6c0f6889ecfcef8cde0f25e61b"},{"relativePath":"evidence/runs/ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a/run_01a10e03-4287-7777-908a-75aa8cbbef1b/att_01a10e03-429d-720a-9e5b-cbbf49bfd911/meta.json","sizeBytes":511,"sha256":"c76b337964aa88c65a6450108bd479a826836d81dd75ba0cdc06cdc0fc0efcf0"}],"databaseVersion":1,"secretIncluded":false},"evidenceComplete":true,"requiresOperatorReview":true},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js project list --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_62b2f7c2-da5b-4400-a633-3275485ee19e","data":[{"archivedAt":null,"createdAt":"2026-10-05T21:40:55.281Z","defaultEnvironmentId":"env_01a10e03-3b72-7325-abf1-b420e78767ca","id":"prj_01a10e03-3b71-7670-a98e-0796caca5893","name":"M1 quickstart","slug":"m1-quickstart","version":2,"workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"}],"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js env list --project prj_01a10e03-3b71-7670-a98e-0796caca5893 --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_ef554d60-521d-410f-84cc-04b2ac1750ca","data":[{"activeRevisionId":"evr_01a10e03-3b72-7325-abf1-b329752b06ea","archivedAt":null,"createdAt":"2026-10-05T21:40:55.282Z","id":"env_01a10e03-3b72-7325-abf1-b420e78767ca","name":"local","projectId":"prj_01a10e03-3b71-7670-a98e-0796caca5893","version":1,"workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"}],"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js env update env_01a10e03-3b72-7325-abf1-b420e78767ca --base-url http://127.0.0.1:39115 --expected-version 1 --output json --no-color
exitCode=0 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_02dc1e0b-44c2-4d4f-a185-34153808f15c","data":{"activeRevisionId":"evr_01a10e03-4a0c-7796-994c-487df5400a09","archivedAt":null,"createdAt":"2026-10-05T21:40:55.282Z","id":"env_01a10e03-3b72-7325-abf1-b420e78767ca","name":"local","projectId":"prj_01a10e03-3b71-7670-a98e-0796caca5893","version":2,"workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"},"warnings":[]}
stderr:

```

```text
$ /usr/bin/node /home/diogo/dev/testmaster/apps/cli/dist/main.js test rerun tst_01a10e03-3ffa-763d-9397-0d7793b68742 --wait --timeout 180 --output json --no-color
exitCode=1 signal=none
stdout:
{"schemaVersion":"1.0.0","requestId":"cli_2517f9c8-0de3-4c96-ac6b-374d7759244c","data":{"receipt":{"runId":"run_01a10e03-4ba9-712b-a0e6-31bb93a76e6c","status":"queued","revisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","environmentRevisionId":"evr_01a10e03-4a0c-7796-994c-487df5400a09","acceptedAt":"2026-10-05T21:40:59.433Z","links":{"self":"/v1/runs/run_01a10e03-4ba9-712b-a0e6-31bb93a76e6c","events":"/v1/runs/run_01a10e03-4ba9-712b-a0e6-31bb93a76e6c/events","bundle":"/v1/runs/run_01a10e03-4ba9-712b-a0e6-31bb93a76e6c/bundle"},"idempotencyKey":"2955aeef-1f57-4961-b8f3-0243381779f9","ownership":"ephemeral"},"run":{"analysisStatus":"not_requested","batchId":null,"cleanupOutcome":"not_required","createdAt":"2026-10-05T21:40:59.433Z","environmentRevisionId":"evr_01a10e03-4a0c-7796-994c-487df5400a09","gate":"failed","gatePolicy":{"cleanupRequired":false,"executor":"docker","ownership":"ephemeral","policyHash":"fef0a2391582cede3a7173e850e57448bd9c8360e062312a65e5be6df67ad0d3","policySatisfied":true,"requiredDependenciesPassed":true,"requiredEvidenceComplete":true},"id":"run_01a10e03-4ba9-712b-a0e6-31bb93a76e6c","matrixCell":{"baseUrl":"http://127.0.0.1:39115","effectiveConfig":{"config":{"artifacts":{"retentionDays":30,"trace":"off","video":"off"},"browser":{"name":"chromium","testIdAttributes":["data-testid"],"viewport":{"height":720,"width":1280}},"environment":{"baseUrl":"http://127.0.0.1:3000","locale":"en-US","networkProfile":"local-loopback","timezone":"UTC"},"execution":{"analysisGraceMs":60000,"artifactBytes":67108864,"attemptArtifactBytes":268435456,"attemptTimeoutMs":300000,"bodyBytes":10485760,"collectionGraceMs":60000,"concurrency":2,"executionTimeoutMs":1800000,"executor":"docker","logBytes":10485760,"maxAttempts":2,"mode":"replay","networkRequestTimeoutMs":30000,"preparationTimeoutMs":120000,"stepTimeoutMs":30000},"healing":{"mode":"off"},"project":{"id":"prj_01a10e03-3b71-7670-a98e-0796caca5893","name":"M1 quickstart"},"schemaVersion":"1.0.0","telemetry":{"enabled":false}},"origins":{"artifacts.retentionDays":"project","artifacts.trace":"project","artifacts.video":"project","browser.name":"project","browser.testIdAttributes":"project","browser.viewport.height":"project","browser.viewport.width":"project","environment.baseUrl":"project","environment.locale":"project","environment.networkProfile":"project","environment.timezone":"project","execution.analysisGraceMs":"project","execution.artifactBytes":"project","execution.attemptArtifactBytes":"project","execution.attemptTimeoutMs":"project","execution.bodyBytes":"project","execution.collectionGraceMs":"project","execution.concurrency":"project","execution.executionTimeoutMs":"project","execution.executor":"project","execution.logBytes":"project","execution.maxAttempts":"project","execution.mode":"project","execution.networkRequestTimeoutMs":"project","execution.preparationTimeoutMs":"project","execution.stepTimeoutMs":"project","healing.mode":"environment","project.id":"project","project.name":"project","schemaVersion":"project","telemetry.enabled":"environment"},"policyHash":"fef0a2391582cede3a7173e850e57448bd9c8360e062312a65e5be6df67ad0d3"},"environmentId":"env_01a10e03-3b72-7325-abf1-b420e78767ca","environmentName":"local","executor":"docker","limits":{"analysisGraceMs":60000,"artifactBytes":67108864,"attemptArtifactBytes":268435456,"attemptTimeoutMs":300000,"bodyBytes":10485760,"collectionGraceMs":60000,"executionTimeoutMs":1800000,"logBytes":10485760,"maxAttempts":2,"networkRequestTimeoutMs":30000,"preparationTimeoutMs":120000,"stepTimeoutMs":30000},"maxConcurrency":2,"ownership":"ephemeral","planHash":"609fbcaa59c27e7595c233d135eee02774dd2fffebc9b5e16fd4d0781697a886","seed":0},"mode":"replay","origin":"cli","outcome":"failed","phase":"completed","revisionId":"rev_01a10e03-3ffd-74f3-bd79-43b3651c0584","status":"failed","testId":"tst_01a10e03-3ffa-763d-9397-0d7793b68742","version":2,"workspaceId":"ws_01a10e03-3b6a-76d7-ae8b-af786a62f12a"}},"warnings":[]}
stderr:

```

Independent oracle:
```json
{
  "baseline": {
    "check": "serviceHealth",
    "healthy": true,
    "defective": false,
    "observed": {
      "status": 200,
      "headers": {
        "content-type": "application/json",
        "cache-control": "no-store",
        "date": "Mon, 05 Oct 2026 21:40:58 GMT",
        "connection": "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked"
      },
      "body": {
        "status": "ok"
      }
    }
  },
  "mutant": {
    "check": "serviceHealth",
    "healthy": false,
    "defective": true,
    "observed": {
      "status": 200,
      "headers": {
        "content-type": "application/json",
        "cache-control": "no-store",
        "date": "Mon, 05 Oct 2026 21:41:00 GMT",
        "connection": "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked"
      },
      "body": {
        "status": "degraded"
      }
    }
  },
  "runId": "run_01a10e03-4ba9-712b-a0e6-31bb93a76e6c"
}
```
