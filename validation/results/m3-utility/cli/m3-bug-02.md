# m3\-bug\-02

Gate: **failed**
Snapshot: snp\_01a1199e\-3b0c\-770c\-8df7\-41c8eab6d89e
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

## m3\-bug\-02
Run: run\_01a1199e\-3adc\-74f2\-92c8\-cd6627b775bd; revision: rev\_01a1199e\-3713\-74ad\-943c\-714daaa27edc; environment: local
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
**Expected:** 3015
**Observed:** null \(empty collection\)
**Conclusion:** The expected behavior was not observed; the internal cause has not been determined\. \(cause partially supported\)
**Next step:** Inspect the creation response at step order and the read at step orders, including entity identity and environment\. \(rules\)
**Automatic healing:** not indicated: A test change would hide the observed behavior mismatch\.
- Observation evidence: \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f\]
- Next step evidence: \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f; step stp\_fb600741 \#081b991caf94; step stp\_2107629f \#121267648dd7\]
- Fact: Run finished with outcome failed and gate failed\. \[evidence: run\_27b775bd \#7acf9237f67c\]
- Fact: Step authenticate \(request\) was passed\. \[evidence: step stp\_4b7e25a1 \#82f6c618929d\]
- Fact: Step cart \(request\) was passed\. \[evidence: step stp\_b82f73d3 \#dc4e2aca94a8\]
- Fact: Step order \(request\) was passed\. \[evidence: step stp\_fb600741 \#081b991caf94\]
- Fact: Step orders \(request\) was passed\. \[evidence: step stp\_2107629f \#121267648dd7\]
- Fact: Step business\_assertion \(assert\) was failed: assertion\_mismatch\. \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f\]
- Fact: Persisted step\.started observation\. \[evidence: run\_27b775bd observation 1 \#3bac9844b145\]
- Fact: Persisted variable\.captured observation\. \[evidence: run\_27b775bd observation 2 \#04ed4384d008\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_27b775bd observation 6 \#8f7db352c213\]
- Fact: Persisted step\.started observation\. \[evidence: run\_27b775bd observation 7 \#9d0c44d37618\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_27b775bd observation 11 \#872a1e16a2a6\]
- Fact: Persisted step\.started observation\. \[evidence: run\_27b775bd observation 12 \#8aa0b5bdd166\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_27b775bd observation 16 \#1dcb4a11935e\]
- Fact: Persisted step\.started observation\. \[evidence: run\_27b775bd observation 17 \#b2997abe24f5\]
- Fact: Persisted step\.finished observation\. \[evidence: run\_27b775bd observation 21 \#d59d14c97dfa\]
- Fact: Persisted step\.started observation\. \[evidence: run\_27b775bd observation 22 \#b2d93adc4bac\]
- Fact: Persisted step\.finished observation: assertion\_mismatch\. \[evidence: run\_27b775bd observation 23 \#08e030c550f0\]
- Fact: Persisted runner\.finished observation: assertion\_mismatch\. \[evidence: run\_27b775bd observation 24 \#9054009359e3\]
- Fact: Persisted run\.completed observation\. \[evidence: run\_27b775bd observation 22 \#4ad4838b556b\]
- Fact: Verified http artifact art\_01a1199e\-3d4d\-7632\-8c18\-e84f2a903e95 is available\. \[evidence: http/authenticate\.json \#9e3e82eafa67\]
- Fact: Verified http artifact art\_01a1199e\-3d6d\-77ba\-9d5d\-d291fe4fafa0 is available\. \[evidence: http/cart\.json \#b6b0c428a749\]
- Fact: Verified http artifact art\_01a1199e\-3d71\-7218\-af42\-af09c2f65673 is available\. \[evidence: http/order\.json \#c9faeaaa12f4\]
- Fact: Verified http artifact art\_01a1199e\-3d74\-7056\-8e12\-b987210ed21a is available\. \[evidence: http/orders\.json \#975af932d7c0\]
- Fact: Verified log artifact art\_01a1199e\-3dca\-759b\-9913\-5b4ba69a4851 is available\. \[evidence: logs/container\.log \#e3b0c44298fc\]
- Fact: Verified snapshot artifact art\_01a1199e\-3dcb\-76e7\-a724\-dbaefb5bd17b is available\. \[evidence: snapshot/runtime\.json \#497a4a3fbec8\]
- Fact: Verified network artifact art\_01a1199e\-3dcb\-76e7\-a724\-dcc290337622 is available\. \[evidence: logs/egress\.ndjson \#17c9a61d2832\]
- Hypothesis: A required business assertion observed a value different from its frozen expectation; this is evidence of a product behavior mismatch, not a proven source\-level root cause\. \(partially supported\) \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f\]; contradicting \[evidence: step stp\_4b7e25a1 \#82f6c618929d; step stp\_b82f73d3 \#dc4e2aca94a8; step stp\_fb600741 \#081b991caf94; step stp\_2107629f \#121267648dd7\]
- Alternative (not established): The expectation may be outdated after a requirement change\. \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f\]
- Alternative (not established): The read may refer to another entity or context\. \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f\]
- Alternative (not established): Environment state or data may differ\. \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f\]
- Step: authenticate: request, passed; Step authenticate \(request\) was passed\. HTTP POST /api/auth/token\. Observed HTTP status 200\.; baseline same \[evidence: step stp\_4b7e25a1 \#82f6c618929d; http/authenticate\.json \#9e3e82eafa67\]
- Step: cart: request, passed; Step cart \(request\) was passed\. HTTP POST /api/cart\. Observed HTTP status 200\.; baseline same \[evidence: step stp\_b82f73d3 \#dc4e2aca94a8; http/cart\.json \#b6b0c428a749\]
- Step: order: request, passed; Step order \(request\) was passed\. HTTP POST /api/orders\. Observed HTTP status 201\.; baseline same \[evidence: step stp\_fb600741 \#081b991caf94; http/order\.json \#c9faeaaa12f4\]
- Step: orders: request, passed; Step orders \(request\) was passed\. HTTP GET /api/orders\. Observed HTTP status 200\.; baseline same \[evidence: step stp\_2107629f \#121267648dd7; http/orders\.json \#975af932d7c0\]
- Step: business\_assertion: assert, failed; Step business\_assertion \(assert\) was failed: assertion\_mismatch\.; verifies orders; baseline different \[evidence: step stp\_a26ed4bd \#9fce2c5dba0f\]
