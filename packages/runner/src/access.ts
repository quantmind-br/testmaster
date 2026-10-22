import type { AccessProbe } from "@testmaster/contracts";
import {
  type PreparedRequest,
  ProbeSteps,
  ProbeTransport,
  type ProbeTransportOptions,
  refusedProbe,
  resolveCredentials,
  TransportFailure,
} from "./probe-support.js";
import { abortVerdict, type RunnerResult, type Runtime, RuntimeError } from "./runtime.js";

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/**
 * Sends each operation as the intruder and then as the owner (REQ-048). An intruder that is not
 * refused with an expected status has reached data it does not own; a refusal only counts when the
 * owner could use the same request, otherwise it proves nothing about authorization.
 */
export async function runAccess(
  runtime: Runtime,
  options: ProbeTransportOptions = {},
): Promise<RunnerResult> {
  const probe = runtime.input.probe;
  if (probe?.kind !== "access")
    throw new RuntimeError("security_precondition_failed", "Access probe is missing");
  const steps = new ProbeSteps(runtime);
  const transport = new ProbeTransport(runtime, options);
  try {
    let prepared: {
      operation: AccessProbe["operations"][number];
      intruder: PreparedRequest;
      owner: PreparedRequest;
    }[];
    try {
      const owner = await resolveCredentials(runtime, probe.owner);
      const intruder = await resolveCredentials(runtime, probe.intruder);
      prepared = probe.operations.map((operation) => ({
        operation,
        intruder: transport.prepare(operation, intruder),
        owner: transport.prepare(operation, owner),
      }));
    } catch (error) {
      if (error instanceof RuntimeError) return await refusedProbe(runtime, steps, "access", error);
      throw error;
    }
    const seen = new Map<string, number>();
    let failures = 0;
    for (const { operation, intruder, owner } of prepared) {
      if (runtime.signal.aborted) break;
      const label = `${operation.method} ${operation.path}`;
      const occurrence = (seen.get(label) ?? 0) + 1;
      seen.set(label, occurrence);
      const step = await steps.start(`access:${label}${occurrence > 1 ? ` #${occurrence}` : ""}`);
      let intruderStatus: number;
      try {
        intruderStatus = (await transport.send(intruder, runtime.signal)).status;
      } catch (error) {
        const aborted = abortVerdict(runtime.signal);
        await steps.finish(step, {
          status: aborted?.outcome ?? "inconclusive",
          reasonCode: aborted?.reasonCode ?? "insufficient_evidence",
          error: transportError(error),
        });
        continue;
      }
      let ownerStatus: number | null = null;
      let ownerFailure: unknown;
      try {
        ownerStatus = (await transport.send(owner, runtime.signal)).status;
      } catch (error) {
        ownerFailure = error;
      }
      const expected = { intruderStatus: [...probe.expect], ownerStatus: "2xx" };
      const observed = { intruderStatus, ownerStatus };
      if (!isSuccess(intruderStatus) && probe.expect.includes(intruderStatus as 401 | 403 | 404)) {
        if (ownerStatus !== null && isSuccess(ownerStatus)) {
          await steps.finish(step, { status: "passed" });
        } else {
          const aborted = abortVerdict(runtime.signal);
          await steps.finish(step, {
            status: aborted?.outcome ?? "inconclusive",
            reasonCode: aborted?.reasonCode ?? "insufficient_evidence",
            error:
              ownerFailure === undefined
                ? {
                    code: "owner_refused",
                    message: `The owner request was answered with status ${ownerStatus}, so the intruder's refusal proves nothing`,
                  }
                : transportError(ownerFailure),
            expected,
            observed,
          });
        }
        continue;
      }
      failures += 1;
      const path = `access/${failures}.json`;
      await runtime.artifact(
        path,
        "access-evidence",
        "application/json",
        Buffer.from(
          JSON.stringify(
            {
              operation: { method: operation.method, path: operation.path },
              intruderStatus,
              ownerStatus,
              expected: [...probe.expect],
            },
            null,
            2,
          ),
        ),
      );
      const granted = isSuccess(intruderStatus);
      await steps.finish(step, {
        status: "failed",
        reasonCode: "assertion_mismatch",
        error: {
          code: granted ? "access_granted" : "unexpected_status",
          message: granted
            ? `The intruder received status ${intruderStatus} for ${label}`
            : `The intruder received status ${intruderStatus} for ${label}; expected ${probe.expect.join(", ")}`,
        },
        expected,
        observed,
        evidencePaths: [path],
      });
    }
    const aborted = abortVerdict(runtime.signal);
    const aggregate = aborted
      ? { status: aborted.outcome, reasonCode: aborted.reasonCode }
      : steps.aggregate();
    const step = await steps.start("access");
    await steps.finish(step, aggregate);
    return (
      aborted ?? {
        outcome: aggregate.status,
        reasonCode: aggregate.reasonCode,
      }
    );
  } finally {
    await transport.close();
  }
}

function transportError(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof TransportFailure && error.code ? error.code : "transport_error",
    message: "HTTP transport did not produce a complete usable response",
  };
}
