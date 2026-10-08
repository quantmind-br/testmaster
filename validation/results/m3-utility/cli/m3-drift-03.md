# m3\-drift\-03

Gate: **failed**
Snapshot: snp\_01a119a8\-5130\-747e\-a491\-1d62caf465b9
Completeness: complete
Selection: 1; not dispatched: 0; excluded: 0
Coverage requirement: unknown; Current project requirement inventory and active accepted revisions; mapping only
Coverage route: unknown; Observed navigation; discovery is partial and total application route inventory is unknown
Coverage operation: unknown; Ready current OpenAPI sources; method/path/status/media/schema pairs with passing status and schema assertions
Coverage code: unknown; No code instrumentation supplied
Coverage execution: 1/1 (100.00%); Frozen requested selection; dependency expansion excluded
selectionCompletionRate: 1/1 (100.00%)
strictPassRate: 0/1 (0.00%)
terminalPassRate: 0/1 (0.00%)
blockedRate: 0/1 (0.00%)
inconclusiveRate: 0/1 (0.00%)
gatePassRate: 0/1 (0.00%)
retryRecoveryRate: notApplicable
diagnosticRetryPassRate: notApplicable
firstAttemptFailureRate: 1/1 (100.00%)
artifactCompletenessRate: 1/1 (100.00%)
staleEvidenceRate: 1/1 (100.00%)
requirementMappingCoverage: insufficientData
endpointContractCoverage: insufficientData
verifiedRequirementCoverage: insufficientData
Execution counts: {"requested":1,"accepted":1,"notDispatched":0,"expanded":0,"allMembers":1,"executed":1,"attempts":1,"retried":0,"duplicates":0,"excluded":0,"passed":0,"failed":1,"blocked":0,"cancelled":0,"inconclusive":0,"nonterminal":0}
Exclusions: {"firstAttemptNonPassOrFail":0,"expandedDependencies":0,"authorizedExcluded":0,"duplicateSelections":0}

## m3\-drift\-03
Run: run\_01a119a8\-50f8\-713f\-adb3\-8f843e9a47c4; revision: rev\_01a119a8\-49d8\-70e2\-9d5a\-7388664fed12; environment: local
Outcome: failed; gate: failed; cleanup: not_required
First attempt: failed; passed on retry: false
Reproduction: evidence-replay; execution: strict-execution-replay
- Reproduction limitation: mutable\-external\-target
- Reproduction limitation: mutable\-external\-payload
- Reproduction limitation: browser\-platform\-rendering
- Reproduction limitation: repository\-commit\-unavailable
- Reproduction limitation: source\-binding\-unavailable
- Reproduction limitation: source\-dependency\-lock\-unavailable
Context: stale (test_revision_changed)

### Diagnosis
**Failure:** Step invalid\_password \(fill\) was failed: assertion\_timeout\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password&quot;\}\.
**Expected:** null
**Observed:** null \(null value\)
**Conclusion:** The failure is localized to step invalid\_password; the evidence does not establish a cause\. \(cause unknown\)
**Next step:** Inspect locator candidates for step invalid\_password to distinguish a changed control from a missing or ambiguous target\. \(rules\)
**Automatic healing:** manual review only: Observed candidates do not establish unique baseline identity\.
- Observation evidence: \[evidence: step stp\_54dabb54 \#476872216519\]
- Next step evidence: \[evidence: browser/steps/invalid\_password\-locator\-0\-before\.json \#b38400296b3d; browser/steps/invalid\_password\-locator\-0\-after\.json \#db477a479f8c\]
- Fact: Run finished with outcome failed and gate failed\. \[evidence: run\_3e9a47c4 \#67be8b379283\]
- Fact: Step invalid\_open \(navigate\) was passed\. \[evidence: step stp\_fcef0da0 \#f346f0a10536\]
- Fact: Step invalid\_email \(fill\) was passed\. \[evidence: step stp\_0456fb59 \#c403b97c4eff\]
- Fact: Step invalid\_password \(fill\) was failed: assertion\_timeout\. \[evidence: step stp\_54dabb54 \#476872216519\]
- Fact: Step invalid\_submit \(click\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_da5ed611 \#575202f0b41e\]
- Fact: Step invalid\_login\_assertion \(assert\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_c8b3fe9e \#5f2d68e4e995\]
- Fact: Step open\_login \(navigate\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_05ba8502 \#1fa412073bff\]
- Fact: Step email \(fill\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_19f9e438 \#b85615d424db\]
- Fact: Step password \(fill\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_ca96a830 \#45a73b6b28bc\]
- Fact: Step signin \(click\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_07c4ea33 \#e279becd7e64\]
- Fact: Step catalog\_ready \(assert\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_77353ce8 \#c69fe7a92efb\]
- Fact: Persisted step\.started observation\. \[evidence: run\_3e9a47c4 observation 1 \#922ebc026d0a\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_3e9a47c4 observation 14 \#7c6657db7f96\]
- Fact: Persisted step\.started observation\. \[evidence: run\_3e9a47c4 observation 15 \#903829763a09\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_3e9a47c4 observation 34 \#092731bdf74d\]
- Fact: Persisted step\.started observation\. \[evidence: run\_3e9a47c4 observation 35 \#c71440e13ae6\]
- Fact: Persisted step\.finished observation: assertion\_timeout\. \[evidence: run\_3e9a47c4 observation 54 \#7a8cf25b2892\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_3e9a47c4 observation 55 \#26522f93e2bd\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_3e9a47c4 observation 56 \#cc59ec9dc54d\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_3e9a47c4 observation 57 \#f23766230571\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_3e9a47c4 observation 58 \#7e666ca2383a\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_3e9a47c4 observation 59 \#b44a8b1af190\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_3e9a47c4 observation 60 \#f8d376ff2bc1\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_3e9a47c4 observation 61 \#06339b742806\]
- Fact: Persisted runner\.finished observation: assertion\_timeout\. \[evidence: run\_3e9a47c4 observation 68 \#1d72b9e4b5af\]
- Fact: Persisted run\.completed observation\. \[evidence: run\_3e9a47c4 observation 24 \#fdbd4f027076\]
- Fact: Verified screenshot artifact art\_01a119a8\-5547\-755d\-b1a8\-9036f80ce7a2 is available\. \[evidence: browser/steps/invalid\_open\-before\.png \#3878570f4a62\]
- Fact: Verified dom artifact art\_01a119a8\-5549\-7512\-acc6\-12dfd2425ae6 is available\. \[evidence: browser/steps/invalid\_open\-before\.html \#a7fe83ec64bb\]
- Fact: Verified screenshot artifact art\_01a119a8\-5568\-7594\-b17d\-823bd06c5d6c is available\. \[evidence: browser/steps/invalid\_open\-after\.png \#4b638e80f923\]
- Fact: Verified dom artifact art\_01a119a8\-556a\-73c1\-a56f\-743e0647df57 is available\. \[evidence: browser/steps/invalid\_open\-after\.html \#55aede1e2da3\]
- Fact: Verified locator\-evidence artifact art\_01a119a8\-557d\-740a\-88d9\-aef82deda00a is available\. \[evidence: browser/steps/invalid\_email\-locator\-0\-before\.json \#466b1b8c2b53\]
- Fact: Verified screenshot artifact art\_01a119a8\-5599\-70d2\-a4b8\-396883fb7769 is available\. \[evidence: browser/steps/invalid\_email\-before\.png \#4b638e80f923\]
- Fact: Verified dom artifact art\_01a119a8\-559b\-74f5\-bd70\-bb19ad826ded is available\. \[evidence: browser/steps/invalid\_email\-before\.html \#55aede1e2da3\]
- Fact: Verified locator\-evidence artifact art\_01a119a8\-55a5\-7249\-b16b\-13d1e15dba53 is available\. \[evidence: browser/steps/invalid\_email\-locator\-0\-after\.json \#dda923e6a1f7\]
- Fact: Verified screenshot artifact art\_01a119a8\-55ba\-709b\-92ba\-d529da7783cb is available\. \[evidence: browser/steps/invalid\_email\-after\.png \#15b592306d57\]
- Fact: Verified dom artifact art\_01a119a8\-55bc\-75b5\-b80a\-1447a68a5ee6 is available\. \[evidence: browser/steps/invalid\_email\-after\.html \#55aede1e2da3\]
- Fact: Verified locator\-evidence artifact art\_01a119a8\-caf3\-7694\-a505\-bf24fc2a8ae0 is available\. \[evidence: browser/steps/invalid\_password\-locator\-0\-before\.json \#b38400296b3d\]
- Fact: Verified screenshot artifact art\_01a119a8\-cb0b\-7201\-bf4a\-9fac7ed1b645 is available\. \[evidence: browser/steps/invalid\_password\-before\.png \#15b592306d57\]
- Fact: Verified dom artifact art\_01a119a8\-cb0c\-754e\-bc55\-0afd8038c170 is available\. \[evidence: browser/steps/invalid\_password\-before\.html \#55aede1e2da3\]
- Fact: Verified locator\-evidence artifact art\_01a119a8\-cb0f\-77d6\-8343\-e16eabe72ecd is available\. \[evidence: browser/steps/invalid\_password\-locator\-0\-after\.json \#db477a479f8c\]
- Fact: Verified screenshot artifact art\_01a119a8\-cb2b\-7088\-985b\-65fad8b83b0f is available\. \[evidence: browser/steps/invalid\_password\-after\.png \#15b592306d57\]
- Fact: Verified dom artifact art\_01a119a8\-cb2c\-7255\-a884\-b01be517e596 is available\. \[evidence: browser/steps/invalid\_password\-after\.html \#55aede1e2da3\]
- Fact: Verified console artifact art\_01a119a8\-cb31\-711a\-abbe\-25c883ca7984 is available\. \[evidence: browser/console\.json \#9ef1588ed14e\]
- Fact: Verified network artifact art\_01a119a8\-cb32\-7410\-9f40\-458d3b4d54de is available\. \[evidence: browser/network\.json \#e241a6a61403\]
- Fact: Verified log artifact art\_01a119a8\-cca4\-7631\-ba42\-6a235f462323 is available\. \[evidence: logs/container\.log \#e3b0c44298fc\]
- Fact: Verified snapshot artifact art\_01a119a8\-cca4\-7631\-ba42\-6cb4dcd5486f is available\. \[evidence: snapshot/runtime\.json \#40cc6f7d70df\]
- Fact: Verified network artifact art\_01a119a8\-cca5\-734b\-87d4\-c384a7f71902 is available\. \[evidence: logs/egress\.ndjson \#0f13314c927f\]
- Alternative (not established): The target may be changed, removed, or ambiguous\.
- Step: invalid\_open: navigate, passed; Step invalid\_open \(navigate\) was passed\.; baseline same \[evidence: step stp\_fcef0da0 \#f346f0a10536\]
- Step: invalid\_email: fill, passed; Step invalid\_email \(fill\) was passed\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;email&quot;\}\.; baseline same \[evidence: step stp\_0456fb59 \#c403b97c4eff\]
- Step: invalid\_password: fill, failed; Step invalid\_password \(fill\) was failed: assertion\_timeout\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password&quot;\}\.; baseline different \[evidence: step stp\_54dabb54 \#476872216519\]
- Step: invalid\_submit: click, skipped; Step invalid\_submit \(click\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;role&quot;,&quot;exact&quot;:true,&quot;name&quot;:&quot;Sign in&quot;,&quot;role&quot;:&quot;button&quot;\}\.; baseline different \[evidence: step stp\_da5ed611 \#575202f0b41e\]
- Step: invalid\_login\_assertion: assert, skipped; Step invalid\_login\_assertion \(assert\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password\-error&quot;\}\.; baseline different \[evidence: step stp\_c8b3fe9e \#5f2d68e4e995\]
- Step: open\_login: navigate, skipped; Step open\_login \(navigate\) was skipped: stopped\_after\_failure\.; baseline different \[evidence: step stp\_05ba8502 \#1fa412073bff\]
- Step: email: fill, skipped; Step email \(fill\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;email&quot;\}\.; baseline different \[evidence: step stp\_19f9e438 \#b85615d424db\]
- Step: password: fill, skipped; Step password \(fill\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password&quot;\}\.; baseline different \[evidence: step stp\_ca96a830 \#45a73b6b28bc\]
- Step: signin: click, skipped; Step signin \(click\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;role&quot;,&quot;exact&quot;:true,&quot;name&quot;:&quot;Sign in&quot;,&quot;role&quot;:&quot;button&quot;\}\.; baseline different \[evidence: step stp\_07c4ea33 \#e279becd7e64\]
- Step: catalog\_ready: assert, skipped; Step catalog\_ready \(assert\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;catalog\-ready&quot;\}\.; baseline different \[evidence: step stp\_77353ce8 \#c69fe7a92efb\]
- Evidence gap: Available evidence does not establish a failure cause; timeout or HTTP response alone is not a diagnosis\.
- Limitation: Available evidence does not establish a failure cause; timeout or HTTP response alone is not a diagnosis\.
