import { chmod, mkdir } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { fulfilBackupRequests, scheduleBackup } from "./operations-controllers.js";
import { type OpsStack, opsStack, ownerSession } from "./ops.testkit.js";
import { assertBackupSeparation } from "./server-backup.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const db = (stack: OpsStack) => stack.application.controllerScope().database;
async function ready(): Promise<OpsStack> {
  const stack = await opsStack();
  cleanups.push(() => stack.cleanup());
  return stack;
}
const operationState = (stack: OpsStack, id: string) =>
  db(stack).get<{ state: string; data_json: string }>(
    "SELECT state,data_json FROM admin_operations WHERE id=?",
    id,
  );

it("OPS-024 the backup agent fulfils a queued request, a missing backup fails verification and nothing is invented", async () => {
  const stack = await ready();
  const owner = await ownerSession(stack);
  const backup = owner.operations.requestBackup("agent check");
  const verify = owner.operations.requestRestoreVerification({
    backupId: "20200101T000000Z-missing",
    reason: "unknown backup",
  });
  const outcome = await fulfilBackupRequests(stack.application.controllerScope(), stack.server);
  expect(outcome.completed).toEqual([backup.id]);
  expect(outcome.failed).toEqual([verify.id]);
  const done = operationState(stack, backup.id);
  expect(done?.state).toBe("completed");
  expect(JSON.parse(String(done?.data_json)).result.backupId).toMatch(/^[0-9a-f-]{36}$/);
  const failed = operationState(stack, verify.id);
  expect(failed?.state).toBe("failed");
  expect(JSON.parse(String(failed?.data_json)).error.code).toBe("NOT_FOUND");

  const verifyReal = owner.operations.requestRestoreVerification({
    backupId: String(JSON.parse(String(done?.data_json)).result.backupId),
    reason: "verify the real one",
  });
  await fulfilBackupRequests(stack.application.controllerScope(), stack.server);
  expect(operationState(stack, verifyReal.id)?.state).toBe("completed");
  // Nothing is left to claim: a second pass changes nothing.
  expect(await fulfilBackupRequests(stack.application.controllerScope(), stack.server)).toEqual({
    completed: [],
    failed: [],
  });
});

it("OPS-024 a request left running by a stopped agent is failed instead of silently retried", async () => {
  const stack = await ready();
  const owner = await ownerSession(stack);
  const request = owner.operations.requestBackup("stale");
  db(stack).run(
    "UPDATE admin_operations SET state='running',started_at=? WHERE id=?",
    "2026-10-01T00:00:00.000Z",
    request.id,
  );
  await fulfilBackupRequests(stack.application.controllerScope(), stack.server, {
    now: () => new Date("2026-10-20T00:00:00.000Z"),
  });
  const row = operationState(stack, request.id);
  expect(row?.state).toBe("failed");
  expect(JSON.parse(String(row?.data_json)).error.message).toContain("stopped");
});

it("OPS-024 schedules one daily backup only when the last success is old and none is pending", async () => {
  const stack = await ready();
  const scope = stack.application.controllerScope();
  const now = new Date("2026-10-20T03:00:00.000Z");
  const first = scheduleBackup(scope, stack.server, now);
  expect(first).toMatch(/^opr_/);
  expect(scheduleBackup(scope, stack.server, now)).toBeNull();
  await fulfilBackupRequests(scope, stack.server, { now: () => now });
  // A fresh success suppresses the next schedule; a day later it is due again.
  expect(scheduleBackup(scope, stack.server, new Date(now.getTime() + 3_600_000))).toBeNull();
  expect(scheduleBackup(scope, stack.server, new Date(now.getTime() + 25 * 3_600_000))).toMatch(
    /^opr_/,
  );
  const disabled = {
    ...stack.server,
    backup: {
      ...(stack.server.backup as NonNullable<typeof stack.server.backup>),
      schedule: "disabled" as const,
    },
  };
  expect(scheduleBackup(scope, disabled, new Date(now.getTime() + 90 * 3_600_000))).toBeNull();
});

it("OPS-024 refuses to run when the server process can read the backup key or write the destination", async () => {
  const stack = await ready();
  const shared = stack.server;
  await assertBackupSeparation(shared); // waived by allowSharedAccess: positive control
  const strict = {
    ...shared,
    backup: { ...(shared.backup as NonNullable<typeof shared.backup>), allowSharedAccess: false },
  };
  await mkdir(strict.backup.destination, { recursive: true });
  // Same user can read the key and write the destination, so the check refuses.
  await expect(assertBackupSeparation(strict)).rejects.toMatchObject({
    details: { reasonCode: "backup_access_not_separated", path: "security.backupKeyFile" },
  });
  if (process.getuid?.() === 0) return; // root ignores file modes: the unreadable-key case cannot be built
  await chmod(strict.security.backupKeyFile, 0o000);
  await expect(assertBackupSeparation(strict)).rejects.toMatchObject({
    details: { reasonCode: "backup_access_not_separated", path: "backup.destination" },
  });
  await chmod(strict.backup.destination, 0o500);
  await assertBackupSeparation(strict);
  await chmod(strict.security.backupKeyFile, 0o600);
  await chmod(strict.backup.destination, 0o700);
});
