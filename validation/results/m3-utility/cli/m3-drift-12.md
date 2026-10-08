# m3\-drift\-12

Gate: **failed**
Snapshot: snp\_01a119ba\-2546\-7631\-9932\-89d7e76f5dc5
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

## m3\-drift\-12
Run: run\_01a119ba\-250a\-7281\-a56a\-e28cfd7b66b8; revision: rev\_01a119ba\-1d1a\-74d9\-b2d4\-902f8812d79d; environment: local
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
**Failure:** Step loading\_finished \(waitFor\) was failed: assertion\_timeout\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;profile\-loading&quot;\}\.
**Expected:** null
**Observed:** null \(null value\)
**Conclusion:** The failure is localized to step loading\_finished; the evidence does not establish a cause\. \(cause unknown\)
**Next step:** Inspect locator candidates for step loading\_finished to distinguish a changed control from a missing or ambiguous target\. \(rules\)
**Automatic healing:** manual review only: Observed candidates do not establish unique baseline identity\.
- Observation evidence: \[evidence: step stp\_1d8cdfb6 \#ba8367b25839\]
- Next step evidence: \[evidence: browser/steps/loading\_finished\-locator\-0\-before\.json \#0e6d795de052; browser/steps/loading\_finished\-locator\-0\-after\.json \#621dc580d7a2\]
- Fact: Run finished with outcome failed and gate failed\. \[evidence: run\_fd7b66b8 \#429f8fd31948\]
- Fact: Step open\_login \(navigate\) was passed\. \[evidence: step stp\_df6dc764 \#ed684a288949\]
- Fact: Step email \(fill\) was passed\. \[evidence: step stp\_81843a9b \#916eb4eae09b\]
- Fact: Step password \(fill\) was passed\. \[evidence: step stp\_cac6c9ac \#96597c49b831\]
- Fact: Step signin \(click\) was passed\. \[evidence: step stp\_4bc2c52b \#ceff9d9df730\]
- Fact: Step catalog\_ready \(assert\) was passed\. \[evidence: step stp\_cb272224 \#afa94f514260\]
- Fact: Step profile \(navigate\) was passed\. \[evidence: step stp\_685c7dd4 \#faa23abb1058\]
- Fact: Step loading\_attached \(waitFor\) was passed\. \[evidence: step stp\_6dcaae75 \#0051fd9ee21b\]
- Fact: Step loading\_finished \(waitFor\) was failed: assertion\_timeout\. \[evidence: step stp\_1d8cdfb6 \#ba8367b25839\]
- Fact: Step upload \(upload\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_71eacc35 \#8b73c072a1da\]
- Fact: Step uploaded \(assert\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_7ab00c48 \#b8178e8a47af\]
- Fact: Step download \(download\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_b5129347 \#03257930a16f\]
- Fact: Step business\_assertion \(assert\) was skipped: stopped\_after\_failure\. \[evidence: step stp\_6266a889 \#473b7fcc0be2\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 1 \#4dba88d6652e\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_fd7b66b8 observation 14 \#5a664c1b46ec\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 15 \#f22d437babe8\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_fd7b66b8 observation 34 \#c25056cb01ed\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 35 \#4f9b555503cd\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_fd7b66b8 observation 54 \#73c44bc25c94\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 55 \#8e48296f8d72\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_fd7b66b8 observation 74 \#54b43e0c5071\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 75 \#d4c195397a6b\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_fd7b66b8 observation 94 \#8f87c1bd09fe\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 95 \#30faec6441c5\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_fd7b66b8 observation 108 \#085cb86b9f12\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 109 \#e8044c82e255\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_fd7b66b8 observation 128 \#8262c5d870a6\]
- Fact: Persisted step\.started observation\. \[evidence: run\_fd7b66b8 observation 129 \#358f6352cd11\]
- Fact: Persisted step\.finished observation: assertion\_timeout\. \[evidence: run\_fd7b66b8 observation 148 \#8e0281c5b3be\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_fd7b66b8 observation 149 \#7e68070639ae\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_fd7b66b8 observation 150 \#6a7964530198\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_fd7b66b8 observation 151 \#b7a1754e8591\]
- Fact: Persisted step\.finished observation: stopped\_after\_failure\. \[evidence: run\_fd7b66b8 observation 152 \#b52fa91e9895\]
- Fact: Persisted runner\.finished observation: assertion\_timeout\. \[evidence: run\_fd7b66b8 observation 159 \#001b62cd72de\]
- Fact: Persisted run\.completed observation\. \[evidence: run\_fd7b66b8 observation 31 \#d85565f5a367\]
- Fact: Verified screenshot artifact art\_01a119ba\-2786\-712d\-9a2d\-7f9471723d69 is available\. \[evidence: browser/steps/open\_login\-before\.png \#3878570f4a62\]
- Fact: Verified dom artifact art\_01a119ba\-2788\-7198\-9be5\-28665fbd61b1 is available\. \[evidence: browser/steps/open\_login\-before\.html \#a7fe83ec64bb\]
- Fact: Verified screenshot artifact art\_01a119ba\-27a8\-7591\-9569\-9e83501591a2 is available\. \[evidence: browser/steps/open\_login\-after\.png \#4b638e80f923\]
- Fact: Verified dom artifact art\_01a119ba\-27aa\-73d2\-867c\-7cffff2f816c is available\. \[evidence: browser/steps/open\_login\-after\.html \#4cf1dfadf247\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-27b8\-77a0\-bc03\-033333d7b378 is available\. \[evidence: browser/steps/email\-locator\-0\-before\.json \#b4ac8728e15a\]
- Fact: Verified screenshot artifact art\_01a119ba\-27c8\-7612\-ab7e\-358d4bc62379 is available\. \[evidence: browser/steps/email\-before\.png \#4b638e80f923\]
- Fact: Verified dom artifact art\_01a119ba\-27c9\-7719\-8b4f\-d24a2d4516ed is available\. \[evidence: browser/steps/email\-before\.html \#4cf1dfadf247\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-27d0\-7201\-8090\-0dcbaf3d52b7 is available\. \[evidence: browser/steps/email\-locator\-0\-after\.json \#20c4bf618adc\]
- Fact: Verified screenshot artifact art\_01a119ba\-27ea\-7736\-93e7\-af17d980dcc8 is available\. \[evidence: browser/steps/email\-after\.png \#15b592306d57\]
- Fact: Verified dom artifact art\_01a119ba\-27eb\-723c\-9dff\-e389cf206fb5 is available\. \[evidence: browser/steps/email\-after\.html \#4cf1dfadf247\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-27f1\-756c\-aa6d\-928fbbb4bc00 is available\. \[evidence: browser/steps/password\-locator\-0\-before\.json \#51ef069ebfcb\]
- Fact: Verified screenshot artifact art\_01a119ba\-280b\-7406\-a5e9\-b37b4167c0ca is available\. \[evidence: browser/steps/password\-before\.png \#15b592306d57\]
- Fact: Verified dom artifact art\_01a119ba\-280c\-759f\-861d\-096a7309366c is available\. \[evidence: browser/steps/password\-before\.html \#4cf1dfadf247\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-2813\-75b0\-998e\-5296e292e498 is available\. \[evidence: browser/steps/password\-locator\-0\-after\.json \#bd9e76482e64\]
- Fact: Verified screenshot artifact art\_01a119ba\-282d\-745d\-b3ce\-e0704a534109 is available\. \[evidence: browser/steps/password\-after\.png \#8c5c29fcb0be\]
- Fact: Verified dom artifact art\_01a119ba\-282f\-749e\-8868\-49db74a3159d is available\. \[evidence: browser/steps/password\-after\.html \#4cf1dfadf247\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-2837\-7467\-be36\-9675b10b1307 is available\. \[evidence: browser/steps/signin\-locator\-0\-before\.json \#f1585e625246\]
- Fact: Verified screenshot artifact art\_01a119ba\-284e\-704a\-9c25\-ce450dd25b90 is available\. \[evidence: browser/steps/signin\-before\.png \#8c5c29fcb0be\]
- Fact: Verified dom artifact art\_01a119ba\-284f\-72ef\-95d8\-7cf13a28179a is available\. \[evidence: browser/steps/signin\-before\.html \#4cf1dfadf247\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-286f\-72be\-81e4\-2e2021675157 is available\. \[evidence: browser/steps/signin\-locator\-0\-after\.json \#7fc81c0d5c42\]
- Fact: Verified screenshot artifact art\_01a119ba\-2880\-7402\-98de\-94e08067ffa0 is available\. \[evidence: browser/steps/signin\-after\.png \#876e2c30e869\]
- Fact: Verified dom artifact art\_01a119ba\-2881\-70e3\-8f36\-ff130c285764 is available\. \[evidence: browser/steps/signin\-after\.html \#ac839e992690\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-2886\-7549\-9fa7\-595d5a281d5d is available\. \[evidence: browser/steps/catalog\_ready\-locator\-0\-before\.json \#061461e0ce30\]
- Fact: Verified screenshot artifact art\_01a119ba\-2890\-7214\-8d42\-4f0669fe30a0 is available\. \[evidence: browser/steps/catalog\_ready\-before\.png \#e91b0bff1cc7\]
- Fact: Verified dom artifact art\_01a119ba\-2890\-7214\-8d42\-53a6f93314ad is available\. \[evidence: browser/steps/catalog\_ready\-before\.html \#ac839e992690\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-28ac\-72e9\-b251\-ead0b4cb0736 is available\. \[evidence: browser/steps/catalog\_ready\-locator\-0\-after\.json \#8930ad5c3080\]
- Fact: Verified screenshot artifact art\_01a119ba\-28c4\-71a5\-bbd0\-3a2b42d6bd86 is available\. \[evidence: browser/steps/catalog\_ready\-after\.png \#b2970f874169\]
- Fact: Verified dom artifact art\_01a119ba\-28c6\-7395\-9bc5\-77cbae1a3e0a is available\. \[evidence: browser/steps/catalog\_ready\-after\.html \#ac18d180c22f\]
- Fact: Verified screenshot artifact art\_01a119ba\-28e5\-722e\-ba4c\-3325d3e66736 is available\. \[evidence: browser/steps/profile\-before\.png \#b2970f874169\]
- Fact: Verified dom artifact art\_01a119ba\-28e7\-7586\-b64c\-4ed794f4299a is available\. \[evidence: browser/steps/profile\-before\.html \#ac18d180c22f\]
- Fact: Verified screenshot artifact art\_01a119ba\-2916\-7701\-89f8\-124c1c620147 is available\. \[evidence: browser/steps/profile\-after\.png \#07a334b8ee4b\]
- Fact: Verified dom artifact art\_01a119ba\-2917\-7355\-951c\-b04dc1870f5e is available\. \[evidence: browser/steps/profile\-after\.html \#67e8d5eb91e3\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-2923\-7260\-a798\-136efd61d926 is available\. \[evidence: browser/steps/loading\_attached\-locator\-0\-before\.json \#97e25274ea2c\]
- Fact: Verified screenshot artifact art\_01a119ba\-2937\-7520\-bd85\-4b5d96ec3cfe is available\. \[evidence: browser/steps/loading\_attached\-before\.png \#07a334b8ee4b\]
- Fact: Verified dom artifact art\_01a119ba\-2938\-7222\-b903\-3601a432ffbf is available\. \[evidence: browser/steps/loading\_attached\-before\.html \#67e8d5eb91e3\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-296f\-7563\-ba5c\-4d5d7c52a3ac is available\. \[evidence: browser/steps/loading\_attached\-locator\-0\-after\.json \#96ea297f4b4c\]
- Fact: Verified screenshot artifact art\_01a119ba\-298b\-7418\-bd47\-ed53c5dc61d0 is available\. \[evidence: browser/steps/loading\_attached\-after\.png \#07a334b8ee4b\]
- Fact: Verified dom artifact art\_01a119ba\-298c\-723a\-8275\-12ad34f19b1b is available\. \[evidence: browser/steps/loading\_attached\-after\.html \#67e8d5eb91e3\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-2990\-7659\-9c67\-14d78e9ba4c5 is available\. \[evidence: browser/steps/loading\_finished\-locator\-0\-before\.json \#0e6d795de052\]
- Fact: Verified screenshot artifact art\_01a119ba\-29ab\-70a6\-b73a\-03990595e4c7 is available\. \[evidence: browser/steps/loading\_finished\-before\.png \#07a334b8ee4b\]
- Fact: Verified dom artifact art\_01a119ba\-29ac\-72f6\-8c7a\-6c950a3e61e4 is available\. \[evidence: browser/steps/loading\_finished\-before\.html \#67e8d5eb91e3\]
- Fact: Verified locator\-evidence artifact art\_01a119ba\-3572\-7199\-8331\-f8d630b3818f is available\. \[evidence: browser/steps/loading\_finished\-locator\-0\-after\.json \#621dc580d7a2\]
- Fact: Verified screenshot artifact art\_01a119ba\-3586\-701f\-afe3\-b30bc511a6c5 is available\. \[evidence: browser/steps/loading\_finished\-after\.png \#5890474691cc\]
- Fact: Verified dom artifact art\_01a119ba\-3587\-77b7\-88c3\-73a6d155301c is available\. \[evidence: browser/steps/loading\_finished\-after\.html \#209f6a18103b\]
- Fact: Verified console artifact art\_01a119ba\-358c\-77bb\-b613\-9fa9a8381002 is available\. \[evidence: browser/console\.json \#345d75d0ba1c\]
- Fact: Verified network artifact art\_01a119ba\-358c\-77bb\-b613\-a22d80081e35 is available\. \[evidence: browser/network\.json \#ea76dfd5cd8d\]
- Fact: Verified log artifact art\_01a119ba\-36de\-716e\-90b9\-57a1f47fa27d is available\. \[evidence: logs/container\.log \#e3b0c44298fc\]
- Fact: Verified snapshot artifact art\_01a119ba\-36df\-719d\-a195\-73a8eb5a62a3 is available\. \[evidence: snapshot/runtime\.json \#da613296d76a\]
- Fact: Verified network artifact art\_01a119ba\-36df\-719d\-a195\-7576e82c72bd is available\. \[evidence: logs/egress\.ndjson \#cfa66b18fdf7\]
- Alternative (not established): The target may be changed, removed, or ambiguous\.
- Step: open\_login: navigate, passed; Step open\_login \(navigate\) was passed\.; baseline same \[evidence: step stp\_df6dc764 \#ed684a288949\]
- Step: email: fill, passed; Step email \(fill\) was passed\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;email&quot;\}\.; baseline same \[evidence: step stp\_81843a9b \#916eb4eae09b\]
- Step: password: fill, passed; Step password \(fill\) was passed\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;password&quot;\}\.; baseline same \[evidence: step stp\_cac6c9ac \#96597c49b831\]
- Step: signin: click, passed; Step signin \(click\) was passed\. Locator \{&quot;by&quot;:&quot;role&quot;,&quot;exact&quot;:true,&quot;name&quot;:&quot;Sign in&quot;,&quot;role&quot;:&quot;button&quot;\}\.; baseline same \[evidence: step stp\_4bc2c52b \#ceff9d9df730\]
- Step: catalog\_ready: assert, passed; Step catalog\_ready \(assert\) was passed\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;catalog\-ready&quot;\}\.; baseline same \[evidence: step stp\_cb272224 \#afa94f514260\]
- Step: profile: navigate, passed; Step profile \(navigate\) was passed\.; baseline same \[evidence: step stp\_685c7dd4 \#faa23abb1058\]
- Step: loading\_attached: waitFor, passed; Step loading\_attached \(waitFor\) was passed\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;profile\-loading&quot;\}\.; baseline same \[evidence: step stp\_6dcaae75 \#0051fd9ee21b\]
- Step: loading\_finished: waitFor, failed; Step loading\_finished \(waitFor\) was failed: assertion\_timeout\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;profile\-loading&quot;\}\.; baseline different \[evidence: step stp\_1d8cdfb6 \#ba8367b25839\]
- Step: upload: upload, skipped; Step upload \(upload\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;profile\-upload&quot;\}\.; baseline different \[evidence: step stp\_71eacc35 \#8b73c072a1da\]
- Step: uploaded: assert, skipped; Step uploaded \(assert\) was skipped: stopped\_after\_failure\. Locator \{&quot;by&quot;:&quot;testId&quot;,&quot;value&quot;:&quot;upload\-size&quot;\}\.; baseline different \[evidence: step stp\_7ab00c48 \#b8178e8a47af\]
- Step: download: download, skipped; Step download \(download\) was skipped: stopped\_after\_failure\.; baseline different \[evidence: step stp\_b5129347 \#03257930a16f\]
- Step: business\_assertion: assert, skipped; Step business\_assertion \(assert\) was skipped: stopped\_after\_failure\.; baseline different \[evidence: step stp\_6266a889 \#473b7fcc0be2\]
- Evidence gap: Available evidence does not establish a failure cause; timeout or HTTP response alone is not a diagnosis\.
- Limitation: Available evidence does not establish a failure cause; timeout or HTTP response alone is not a diagnosis\.
