import { ContractError } from "@testmaster/contracts";
import { type ExecutorKind, executorResources } from "@testmaster/sandbox";

export interface WorkerCapacity {
  cpu: number;
  memoryBytes: number;
  pids: number;
  diskBytes: number;
  pools: Record<ExecutorKind, number>;
}
export function validateCapacity(capacity: WorkerCapacity): WorkerCapacity {
  for (const value of [
    capacity.cpu,
    capacity.memoryBytes,
    capacity.pids,
    capacity.diskBytes,
    capacity.pools.browser,
    capacity.pools.http,
    capacity.pools.python,
  ])
    if (!Number.isFinite(value) || value < 0)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Worker capacity must contain finite nonnegative budgets",
      );
  if (
    ![capacity.pools.browser, capacity.pools.http, capacity.pools.python, capacity.pids].every(
      Number.isInteger,
    )
  )
    throw new ContractError(
      "INVALID_ARGUMENT",
      "Worker pool slots and PID budget must be integers",
    );
  return capacity;
}
export function fitsCapacity(
  capacity: WorkerCapacity,
  active: readonly ExecutorKind[],
  kind: ExecutorKind,
): boolean {
  const requested = executorResources[kind];
  const used = active.reduce(
    (total, item) => {
      const resources = executorResources[item];
      return {
        cpu: total.cpu + resources.cpu,
        memoryBytes: total.memoryBytes + resources.memoryBytes,
        pids: total.pids + resources.pids,
        diskBytes: total.diskBytes + resources.diskBytes,
      };
    },
    { cpu: 0, memoryBytes: 0, pids: 0, diskBytes: 0 },
  );
  return (
    active.filter((item) => item === kind).length < capacity.pools[kind] &&
    used.cpu + requested.cpu <= capacity.cpu * 0.75 &&
    used.memoryBytes + requested.memoryBytes <= capacity.memoryBytes * 0.75 &&
    used.pids + requested.pids <= capacity.pids &&
    used.diskBytes + requested.diskBytes <= capacity.diskBytes
  );
}
