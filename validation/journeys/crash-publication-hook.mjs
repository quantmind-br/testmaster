// Loaded explicitly by acceptance subprocesses, never imported by product code.
if (process.env.TESTMASTER_ACCEPTANCE_FAULTS !== "1")
  throw new Error("Acceptance faults are disabled");
const { ExecutionRepository, PersistenceDatabase, LeaseRepository } = await import(
  "../../packages/persistence/dist/index.js"
);
const { writeFileSync } = await import("node:fs");
const fault = process.env.TESTMASTER_ACCEPTANCE_BOUNDARY ?? "";
const marker = process.env.TESTMASTER_ACCEPTANCE_MARKER;
const { watch, existsSync } = await import("node:fs");
const { dirname } = await import("node:path");
const { EntityRepository } = await import("../../packages/persistence/dist/index.js");
const insert = EntityRepository.prototype.insert;
let authoring = false;
EntityRepository.prototype.insert = function (kind, ...args) {
  if (
    (kind === "TestRevision" && fault.includes("revision")) ||
    (kind === "Run" && fault.includes("admission"))
  ) {
    authoring = true;
    if (fault.startsWith("before-")) kill(fault);
  }
  return insert.call(this, kind, ...args);
};
function kill(boundary) {
  if (marker) writeFileSync(marker, boundary, { mode: 0o600 });
  process.kill(process.pid, "SIGKILL");
}
const publish = ExecutionRepository.prototype.publish;
let publishing = false;
let claimed = false;
ExecutionRepository.prototype.publish = function (fence, kind, value) {
  if (kind === "Snapshot") {
    if (fault === "before-publication") kill(fault);
    if (fault === "publication-failure")
      this.database.run("INSERT INTO acceptance_missing_publication_table VALUES(1)");
    publishing = true;
  }
  return publish.call(this, fence, kind, value);
};
const transaction = PersistenceDatabase.prototype.withTx;
PersistenceDatabase.prototype.withTx = function (fn) {
  const result = transaction.call(this, fn);
  if (authoring && (fault === "after-revision" || fault === "after-admission")) kill(fault);
  if (publishing && fault === "after-publication") kill(fault);
  if (claimed && fault === "after-claim") kill(fault);
  return result;
};
const finalize = ExecutionRepository.prototype.finalize;
ExecutionRepository.prototype.finalize = function (...args) {
  const result = finalize.apply(this, args);
  if (fault === "after-finalization") kill(fault);
  return result;
};
const claim = LeaseRepository.prototype.claim;
LeaseRepository.prototype.claim = function (...args) {
  const result = claim.apply(this, args);
  if (result && fault === "after-claim") claimed = true;
  return result;
};
const { FileEvidenceStore } = await import("../../packages/evidence/dist/index.js");
const openAttempt = FileEvidenceStore.prototype.openAttempt;
FileEvidenceStore.prototype.openAttempt = async function (...args) {
  const stage = await openAttempt.apply(this, args);
  const commit = stage.commit.bind(stage);
  stage.commit = async (...meta) => {
    const result = await commit(...meta);
    if (fault === "pause-publication" && marker) {
      writeFileSync(marker, result.bundleDir);
      await new Promise((resolve) => {
        const check = () => {
          if (existsSync(`${marker}.release`)) {
            watcher.close();
            resolve();
          }
        };
        const watcher = watch(dirname(marker), check);
        check();
      });
    }
    return result;
  };
  const beginArtifact = stage.beginArtifact.bind(stage);
  stage.beginArtifact = async (...input) => {
    const writer = await beginArtifact(...input);
    const write = writer.write.bind(writer);
    writer.write = async (...chunks) => {
      await write(...chunks);
      if (fault === "during-upload") kill(fault);
    };
    return writer;
  };
  return stage;
};
