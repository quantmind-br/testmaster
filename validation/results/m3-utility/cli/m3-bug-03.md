# m3\-bug\-03

Gate: **failed**
Snapshot: snp\_01a1199f\-a3dc\-71bf\-9a71\-032606fed99d
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

## m3\-bug\-03
Run: run\_01a1199f\-a3af\-752d\-8758\-c3bc0fd19785; revision: rev\_01a1199f\-9fe2\-737b\-aab2\-5030297f1543; environment: local
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
**Failure:** Step business\_assertion \(assert\) was failed: assertion\_mismatch\.
**Expected:** &quot;ok&quot;
**Observed:** &quot;degraded&quot;
**Conclusion:** The expected behavior was not observed; the internal cause has not been determined\. \(cause partially supported\)
**Next step:** Compare the observed value at step business\_assertion with the approved requirement before changing product code or the test\. \(rules\)
**Automatic healing:** not indicated: A test change would hide the observed behavior mismatch\.
- Observation evidence: \[evidence: step stp\_cae064cd \#0f5427b73ddc\]
- Next step evidence: \[evidence: step stp\_cae064cd \#0f5427b73ddc\]
- Fact: Run finished with outcome failed and gate failed\. \[evidence: run\_0fd19785 \#69ed2257604b\]
- Fact: Step health \(request\) was passed\. \[evidence: step stp\_6d4f40f5 \#fc3784367f62\]
- Fact: Step business\_assertion \(assert\) was failed: assertion\_mismatch\. \[evidence: step stp\_cae064cd \#0f5427b73ddc\]
- Fact: Persisted step\.started observation\. \[evidence: run\_0fd19785 observation 1 \#8f4d2c92963c\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_0fd19785 observation 5 \#ffc03f0bd2b0\]
- Fact: Persisted step\.started observation\. \[evidence: run\_0fd19785 observation 6 \#f3696d80f238\]
- Fact: Persisted step\.finished observation: assertion\_mismatch\. \[evidence: run\_0fd19785 observation 7 \#4e5fa83d0eb1\]
- Fact: Persisted runner\.finished observation: assertion\_mismatch\. \[evidence: run\_0fd19785 observation 8 \#be00a3a494b0\]
- Fact: Persisted run\.completed observation\. \[evidence: run\_0fd19785 observation 15 \#f55644b54ad7\]
- Fact: Verified http artifact art\_01a1199f\-a61e\-75e2\-8afa\-f94ce18aab77 is available\. \[evidence: http/health\.json \#74e14c5588a3\]
- Fact: Verified log artifact art\_01a1199f\-a6a9\-7332\-9560\-38ef7ed7d025 is available\. \[evidence: logs/container\.log \#e3b0c44298fc\]
- Fact: Verified snapshot artifact art\_01a1199f\-a6aa\-73f1\-808c\-c9b59358d93b is available\. \[evidence: snapshot/runtime\.json \#d9579500091b\]
- Fact: Verified network artifact art\_01a1199f\-a6aa\-73f1\-808c\-ce56b02914af is available\. \[evidence: logs/egress\.ndjson \#b93321d7b620\]
- Hypothesis: A required business assertion observed a value different from its frozen expectation; this is evidence of a product behavior mismatch, not a proven source\-level root cause\. \(partially supported\) \[evidence: step stp\_cae064cd \#0f5427b73ddc\]; contradicting \[evidence: step stp\_6d4f40f5 \#fc3784367f62\]
- Alternative (not established): The expectation may be outdated after a requirement change\. \[evidence: step stp\_cae064cd \#0f5427b73ddc\]
- Alternative (not established): The read may refer to another entity or context\. \[evidence: step stp\_cae064cd \#0f5427b73ddc\]
- Alternative (not established): Environment state or data may differ\. \[evidence: step stp\_cae064cd \#0f5427b73ddc\]
- Step: health: request, passed; Step health \(request\) was passed\. HTTP GET /health\. Observed HTTP status 200\.; baseline same \[evidence: step stp\_6d4f40f5 \#fc3784367f62; http/health\.json \#74e14c5588a3\]
- Step: business\_assertion: assert, failed; Step business\_assertion \(assert\) was failed: assertion\_mismatch\.; verifies health; baseline different \[evidence: step stp\_cae064cd \#0f5427b73ddc\]
