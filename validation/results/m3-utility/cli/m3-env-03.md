# m3\-env\-03

Gate: **failed**
Snapshot: report:dcf3a048ac0f0b147dcb7966a2a88f47448280bf1c17e35ace56a3cff31b3147
Completeness: partial
Selection: 1; not dispatched: 0; excluded: 0
- Incomplete: PRECONDITION\_FAILED: Run evidence is missing
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
artifactCompletenessRate: 0/1 (0.00%)
staleEvidenceRate: 0/1 (0.00%)
requirementMappingCoverage: insufficientData
endpointContractCoverage: insufficientData
verifiedRequirementCoverage: insufficientData
Execution counts: {"requested":1,"accepted":1,"notDispatched":0,"expanded":0,"allMembers":1,"executed":1,"attempts":1,"retried":0,"duplicates":0,"excluded":0,"passed":0,"failed":1,"blocked":0,"cancelled":0,"inconclusive":0,"nonterminal":0}
Exclusions: {"firstAttemptNonPassOrFail":0,"expandedDependencies":0,"authorizedExcluded":0,"duplicateSelections":0}

## m3\-env\-03
Run: run\_01a119bb\-da0b\-70f7\-b839\-2107b143656d; revision: rev\_01a119bb\-d60c\-73ea\-b180\-f71a5dc28c2b; environment: local
Outcome: failed; gate: failed; cleanup: inconclusive
First attempt: failed; passed on retry: false
Context: current
- Evidence: PRECONDITION\_FAILED: Run evidence is missing

### Diagnosis
**Failure:** Step business\_assertion \(assert\) was failed: assertion\_mismatch\.
**Expected:** 3015
**Observed:** 3000 \(evidence unavailable\)
**Conclusion:** The expected behavior was not observed; the internal cause has not been determined\. \(cause partially supported\)
**Next step:** Compare the observed value at step business\_assertion with the approved requirement before changing product code or the test\. \(rules\)
**Automatic healing:** not indicated: A test change would hide the observed behavior mismatch\.
- Observation evidence: \[evidence: step stp\_0e372ca7 \#145b77ac5256\]
- Next step evidence: \[evidence: step stp\_0e372ca7 \#145b77ac5256\]
- Fact: Run finished with outcome failed and gate failed\. \[evidence: run\_b143656d \#654a7e5551ca\]
- Fact: Step authenticate \(request\) was passed\. \[evidence: step stp\_66c0f8fa \#9795dee17d84\]
- Fact: Step cart \(request\) was passed\. \[evidence: step stp\_d20b64bc \#8108fc5609ff\]
- Fact: Step order \(request\) was passed\. \[evidence: step stp\_07ca74a1 \#04ba0319abc2\]
- Fact: Step orders \(request\) was passed\. \[evidence: step stp\_644cb196 \#f96ff53718d7\]
- Fact: Step business\_assertion \(assert\) was failed: assertion\_mismatch\. \[evidence: step stp\_0e372ca7 \#145b77ac5256\]
- Fact: Persisted step\.started observation\. \[evidence: run\_b143656d observation 1 \#99d35d5ff950\]
- Fact: Persisted variable\.captured observation\. \[evidence: run\_b143656d observation 2 \#0c2ccc9babeb\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_b143656d observation 6 \#e4e3d264c6e1\]
- Fact: Persisted step\.started observation\. \[evidence: run\_b143656d observation 7 \#1b1367289a14\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_b143656d observation 11 \#57259cf8404b\]
- Fact: Persisted step\.started observation\. \[evidence: run\_b143656d observation 12 \#6dff9b433fef\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_b143656d observation 16 \#10a33e4254f0\]
- Fact: Persisted step\.started observation\. \[evidence: run\_b143656d observation 17 \#858f4c27e9bb\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_b143656d observation 21 \#c03b40d3ec27\]
- Fact: Persisted step\.started observation\. \[evidence: run\_b143656d observation 22 \#8d081842240b\]
- Fact: Persisted step\.finished observation: assertion\_mismatch\. \[evidence: run\_b143656d observation 23 \#9d86cb2049e6\]
- Fact: Persisted runner\.finished observation: assertion\_mismatch\. \[evidence: run\_b143656d observation 24 \#47e50f43f210\]
- Fact: Persisted run\.completed observation\. \[evidence: run\_b143656d observation 21 \#4d714d30481a\]
- Fact: Persisted run\.execution\_error observation: artifact\_limit\_exceeded\. \[evidence: run\_b143656d observation 22 \#8fc40b572849\]
- Hypothesis: A required business assertion observed a value different from its frozen expectation; this is evidence of a product behavior mismatch, not a proven source\-level root cause\. \(partially supported\) \[evidence: step stp\_0e372ca7 \#145b77ac5256\]; contradicting \[evidence: step stp\_66c0f8fa \#9795dee17d84; step stp\_d20b64bc \#8108fc5609ff; step stp\_07ca74a1 \#04ba0319abc2; step stp\_644cb196 \#f96ff53718d7\]
- Alternative (not established): The expectation may be outdated after a requirement change\. \[evidence: step stp\_0e372ca7 \#145b77ac5256\]
- Alternative (not established): The read may refer to another entity or context\. \[evidence: step stp\_0e372ca7 \#145b77ac5256\]
- Alternative (not established): Environment state or data may differ\. \[evidence: step stp\_0e372ca7 \#145b77ac5256\]
- Step: authenticate: request, passed; Step authenticate \(request\) was passed\. HTTP POST /api/auth/token\.; baseline same \[evidence: step stp\_66c0f8fa \#9795dee17d84\]
- Step: cart: request, passed; Step cart \(request\) was passed\. HTTP POST /api/cart\.; baseline same \[evidence: step stp\_d20b64bc \#8108fc5609ff\]
- Step: order: request, passed; Step order \(request\) was passed\. HTTP POST /api/orders\.; baseline same \[evidence: step stp\_07ca74a1 \#04ba0319abc2\]
- Step: orders: request, passed; Step orders \(request\) was passed\. HTTP GET /api/orders\.; baseline same \[evidence: step stp\_644cb196 \#f96ff53718d7\]
- Step: business\_assertion: assert, failed; Step business\_assertion \(assert\) was failed: assertion\_mismatch\.; verifies orders; baseline different \[evidence: step stp\_0e372ca7 \#145b77ac5256\]
- Evidence gap: Committed evidence bundle is unavailable; diagnosis uses persisted execution records only\.
- Limitation: Committed evidence bundle is unavailable; diagnosis uses persisted execution records only\.
