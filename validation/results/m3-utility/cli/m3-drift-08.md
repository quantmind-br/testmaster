# m3\-drift\-08

Gate: **failed**
Snapshot: snp\_01a119b2\-4d1f\-7461\-82df\-322bba71c0b2
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
staleEvidenceRate: 0/1 (0.00%)
requirementMappingCoverage: insufficientData
endpointContractCoverage: insufficientData
verifiedRequirementCoverage: insufficientData
Execution counts: {"requested":1,"accepted":1,"notDispatched":0,"expanded":0,"allMembers":1,"executed":1,"attempts":1,"retried":0,"duplicates":0,"excluded":0,"passed":0,"failed":1,"blocked":0,"cancelled":0,"inconclusive":0,"nonterminal":0}
Exclusions: {"firstAttemptNonPassOrFail":0,"expandedDependencies":0,"authorizedExcluded":0,"duplicateSelections":0}

## m3\-drift\-08
Run: run\_01a119b2\-4ce7\-7292\-b2f1\-d0e0ace42d4b; revision: rev\_01a119b2\-4632\-7714\-9404\-521abf88f537; environment: local
Outcome: failed; gate: failed; cleanup: not_required
First attempt: failed; passed on retry: false
Reproduction: evidence-replay; execution: strict-execution-replay
- Reproduction limitation: mutable\-external\-target
- Reproduction limitation: mutable\-external\-payload
- Reproduction limitation: browser\-platform\-rendering
- Reproduction limitation: repository\-commit\-unavailable
- Reproduction limitation: source\-binding\-unavailable
- Reproduction limitation: source\-dependency\-lock\-unavailable
Context: current

### Diagnosis
**Failure:** Step invalid\_submit \(click\) was failed: assertion\_timeout\. Locator \{&quot;by&quot;:&quot;role&quot;,&quot;exact&quot;:true,&quot;name&quot;:&quot;Sign in&quot;,&quot;role&quot;:&quot;button&quot;\}\.
**Expected:** null
**Observed:** null \(null value\)
**Conclusion:** The failure is localized to step invalid\_submit; the evidence does not establish a cause\. \(cause unknown\)
**Next step:** Inspect locator candidates for step invalid\_submit to distinguish a changed control from a missing or ambiguous target\. \(rules\)
**Automatic healing:** manual review only: Observed candidates do not establish unique baseline identity\.
- Observation evidence: \[evidence: step stp\_c6d7b4f0 \#5bf95be112f8\]
- Next step evidence: \[evidence: browser/steps/invalid\_submit\-locator\-0\-before\.json \#ede422140043; browser/steps/invalid\_submit\-locator\-0\-after\.json \#144933bbfc48\]
- Fact: Run finished with outcome failed and gate failed\. \[evidence: run\_ace42d4b \#ee56d42320ac\]
- Fact: Step invalid\_open \(navigate\) was passed\. \[evidence: step stp\_910f906b \#32fc784dff8b\]
- Fact: Step invalid\_email \(fill\) was passed\. \[evidence: step stp\_07ba21bc \#0d3d233fc959\]
- Fact: Step invalid\_password \(fill\) was passed\. \[evidence: step stp\_bf7b9dd1 \#b9909bfa26ba\]
- Fact: Step invalid\_submit \(click\) was failed: assertion\_timeout\. \[evidence: step stp\_c6d7b4f0 \#5bf95be112f8\]
- Fact: Step invalid\_login\_assertion \(assert\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_963ed58a \#6fa0b9264e54\]
- Fact: Step open\_login \(navigate\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_ad586502 \#71de2a771c3c\]
- Fact: Step email \(fill\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_f6341d0c \#2088786aad12\]
- Fact: Step password \(fill\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_d35a4e16 \#61acf1c818d3\]
- Fact: Step signin \(click\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_145ec116 \#f5cf183f6145\]
- Fact: Step catalog\_ready \(assert\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_5d1a9fb0 \#4f086534108c\]
- Fact: Persisted step\.started observation\. \[evidence: run\_ace42d4b observation 1 \#d816654a67cc\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_ace42d4b observation 14 \#fa61db4f0991\]
- Fact: Persisted step\.started observation\. \[evidence: run\_ace42d4b observation 15 \#cb8ba86c6dad\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_ace42d4b observation 34 \#cd106e8e9e65\]
- Fact: Persisted step\.started observation\. \[evidence: run\_ace42d4b observation 35 \#f1bd0b43ba28\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_ace42d4b observation 54 \#0f2ccd95c343\]
- Fact: Persisted step\.started observation\. \[evidence: run\_ace42d4b observation 55 \#98163ac51d03\]
- Fact: Persisted step\.finished observation: assertion\_timeout\. \[evidence: run\_ace42d4b observation 74 \#abddeac230dc\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_ace42d4b observation 75 \#9e6a03a96bd8\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_ace42d4b observation 76 \#f72c76f8db48\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_ace42d4b observation 77 \#59f30c96efe6\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_ace42d4b observation 78 \#6429215af31e\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_ace42d4b observation 79 \#185e518051fa\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_ace42d4b observation 80 \#9df6c4c7cff5\]
- Fact: Persisted runner\.finished observation: assertion\_timeout\. \[evidence: run\_ace42d4b observation 87 \#53d80253a718\]
- Fact: Persisted run\.completed observation\. \[evidence: run\_ace42d4b observation 25 \#23cfdf24174e\]
- Fact: Verified screenshot artifact art\_01a119b2\-4f67\-7301\-99bb\-7288584cdf6e is available\. \[evidence: browser/steps/invalid\_open\-before\.png \#3878570f4a62\]
- Fact: Verified dom artifact art\_01a119b2\-4f6a\-76c6\-beaf\-af82a280728c is available\. \[evidence: browser/steps/invalid\_open\-before\.html \#a7fe83ec64bb\]
- Fact: Verified screenshot artifact art\_01a119b2\-4f89\-72ff\-92b1\-58e678b37cc3 is available\. \[evidence: browser/steps/invalid\_open\-after\.png \#ef8fd2fbe917\]
- Fact: Verified dom artifact art\_01a119b2\-4f8b\-72f1\-9b04\-0ea24bd93d35 is available\. \[evidence: browser/steps/invalid\_open\-after\.html \#562a808186f9\]
- Fact: Verified locator\-evidence artifact art\_01a119b2\-4f9e\-7489\-9c26\-f5eaeb305b1d is available\. \[evidence: browser/steps/invalid\_email\-locator\-0\-before\.json \#46a043fe4c0e\]
- Fact: Verified screenshot artifact art\_01a119b2\-4fa9\-7135\-af12\-1214827dd6fc is available\. \[evidence: browser/steps/invalid\_email\-before\.png \#ef8fd2fbe917\]
- Fact: Verified dom artifact art\_01a119b2\-4faa\-7014\-ba8b\-c4ce026e9c96 is available\. \[evidence: browser/steps/invalid\_email\-before\.html \#562a808186f9\]
- Fact: Verified locator\-evidence artifact art\_01a119b2\-4fb2\-752b\-a789\-358a6cb6a87f is available\. \[evidence: browser/steps/invalid\_email\-locator\-0\-after\.json \#686655235334\]
- Fact: Verified screenshot artifact art\_01a119b2\-4fca\-72ae\-811c\-0cb6d5335171 is available\. \[evidence: browser/steps/invalid\_email\-after\.png \#b717850ad510\]
- Fact: Verified dom artifact art\_01a119b2\-4fcb\-71dd\-8407\-806ca0defc77 is available\. \[evidence: browser/steps/invalid\_email\-after\.html \#562a808186f9\]
- Fact: Verified locator\-evidence artifact art\_01a119b2\-4fd1\-71de\-8726\-d95dd64b0a99 is available\. \[evidence: browser/steps/invalid\_password\-locator\-0\-before\.json \#766ff0f195c9\]
- Fact: Verified screenshot artifact art\_01a119b2\-4feb\-7613\-b336\-6c795e3bedc9 is available\. \[evidence: browser/steps/invalid\_password\-before\.png \#b717850ad510\]
- Fact: Verified dom artifact art\_01a119b2\-4fed\-7495\-acf5\-aef84faab727 is available\. \[evidence: browser/steps/invalid\_password\-before\.html \#562a808186f9\]
- Fact: Verified locator\-evidence artifact art\_01a119b2\-4ff6\-77f3\-9879\-8248e1daf74f is available\. \[evidence: browser/steps/invalid\_password\-locator\-0\-after\.json \#b078c29a682a\]
- Fact: Verified screenshot artifact art\_01a119b2\-500d\-74bc\-ad8b\-96d17ffbd2c3 is available\. \[evidence: browser/steps/invalid\_password\-after\.png \#7c32e4af15c6\]
- Fact: Verified dom artifact art\_01a119b2\-500e\-7437\-8fb1\-e70b118f3c0d is available\. \[evidence: browser/steps/invalid\_password\-after\.html \#562a808186f9\]
- Fact: Verified locator\-evidence artifact art\_01a119b2\-c545\-77b4\-bf70\-a5a33e97a96b is available\. \[evidence: browser/steps/invalid\_submit\-locator\-0\-before\.json \#ede422140043\]
- Fact: Verified screenshot artifact art\_01a119b2\-c55e\-7667\-bc63\-4e42b5f3e7f0 is available\. \[evidence: browser/steps/invalid\_submit\-before\.png \#7c32e4af15c6\]
- Fact: Verified dom artifact art\_01a119b2\-c55f\-72ad\-a58a\-fb2e9f1531c8 is available\. \[evidence: browser/steps/invalid\_submit\-before\.html \#562a808186f9\]
- Fact: Verified locator\-evidence artifact art\_01a119b2\-c564\-7736\-90ff\-0ee2ee6c92d3 is available\. \[evidence: browser/steps/invalid\_submit\-locator\-0\-after\.json \#144933bbfc48\]
- Fact: Verified screenshot artifact art\_01a119b2\-c57e\-70dd\-a3f1\-302d55119e0e is available\. \[evidence: browser/steps/invalid\_submit\-after\.png \#7c32e4af15c6\]
- Fact: Verified dom artifact art\_01a119b2\-c57f\-7291\-8be4\-63f4fe386d34 is available\. \[evidence: browser/steps/invalid\_submit\-after\.html \#562a808186f9\]
- Fact: Verified console artifact art\_01a119b2\-c584\-700a\-912c\-bfdac0426e02 is available\. \[evidence: browser/console\.json \#9ef1588ed14e\]
- Fact: Verified network artifact art\_01a119b2\-c584\-700a\-912c\-c2acfd690492 is available\. \[evidence: browser/network\.json \#a4a335da28b8\]
- Fact: Verified log artifact art\_01a119b2\-c6fe\-7103\-8aac\-53af68d1707a is available\. \[evidence: logs/container\.log \#e3b0c44298fc\]
- Fact: Verified snapshot artifact art\_01a119b2\-c6fe\-7103\-8aac\-57074d5b1f98 is available\. \[evidence: snapshot/runtime\.json \#3e302d7e7bd5\]
- Fact: Verified network artifact art\_01a119b2\-c6ff\-7564\-b33c\-f59a71ebc5fd is available\. \[evidence: logs/egress\.ndjson \#cdcaf8d8a12a\]
- Alternative (not established): The target may be changed, removed, or ambiguous\.
- Step: invalid\_open: navigate, passed; Step invalid\_open \(navigate\) was passed\.; baseline same \[evidence: step stp\_910f906b \#32fc784dff8b\]
- Step: invalid\_email: fill, passed; Step invalid\_email \(fill\) was passed\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;email&quot;\}\.; baseline same \[evidence: step stp\_07ba21bc \#0d3d233fc959\]
- Step: invalid\_password: fill, passed; Step invalid\_password \(fill\) was passed\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password&quot;\}\.; baseline same \[evidence: step stp\_bf7b9dd1 \#b9909bfa26ba\]
- Step: invalid\_submit: click, failed; Step invalid\_submit \(click\) was failed: assertion\_timeout\. Locator \{&quot;by&quot;:&quot;role&quot;,&quot;exact&quot;:true,&quot;name&quot;:&quot;Sign in&quot;,&quot;role&quot;:&quot;button&quot;\}\.; baseline different \[evidence: step stp\_c6d7b4f0 \#5bf95be112f8\]
- Step: invalid\_login\_assertion: assert, skipped; Step invalid\_login\_assertion \(assert\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password\-error&quot;\}\.; baseline different \[evidence: step stp\_963ed58a \#6fa0b9264e54\]
- Step: open\_login: navigate, skipped; Step open\_login \(navigate\) was skipped: stopped\_after\_failure\.; baseline different \[evidence: step stp\_ad586502 \#71de2a771c3c\]
- Step: email: fill, skipped; Step email \(fill\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;email&quot;\}\.; baseline different \[evidence: step stp\_f6341d0c \#2088786aad12\]
- Step: password: fill, skipped; Step password \(fill\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password&quot;\}\.; baseline different \[evidence: step stp\_d35a4e16 \#61acf1c818d3\]
- Step: signin: click, skipped; Step signin \(click\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;role&quot;,&quot;exact&quot;:true,&quot;name&quot;:&quot;Sign in&quot;,&quot;role&quot;:&quot;button&quot;\}\.; baseline different \[evidence: step stp\_145ec116 \#f5cf183f6145\]
- Step: catalog\_ready: assert, skipped; Step catalog\_ready \(assert\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;catalog\-ready&quot;\}\.; baseline different \[evidence: step stp\_5d1a9fb0 \#4f086534108c\]
- Evidence gap: Available evidence does not establish a failure cause; timeout or HTTP response alone is not a diagnosis\.
- Limitation: Available evidence does not establish a failure cause; timeout or HTTP response alone is not a diagnosis\.
