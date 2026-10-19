import { type RequirementReviewInput, withRequirementStatus } from "@testmaster/application";
import { ContractError, parseStrictJson, validate } from "@testmaster/contracts";
import type { Command } from "commander";
import { listOrPage, withPaging } from "./paging.js";
import {
  collect,
  dryRunReport,
  integer,
  type Options,
  type Runtime,
  required,
  string,
  strings,
  version,
} from "./runtime.js";

/** Requirements per page named in the `--limit` help, the size of the other list pages. */
const LIST_PAGE = 100;

async function patch(runtime: Runtime, options: Options) {
  const file = string(options, "file");
  const text = string(options, "text");
  const criteria = strings(options, "criterion");
  if (file && (text !== undefined || options.criterion !== undefined))
    throw new ContractError(
      "INVALID_ARGUMENT",
      "--file cannot be combined with --text or --criterion",
    );
  if (file) {
    const value = parseStrictJson(await runtime.readInput(file));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ContractError("INVALID_ARGUMENT", "Requirement patch must be an object");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["text", "acceptanceCriteria"].includes(key)) ||
      (record.text !== undefined && typeof record.text !== "string") ||
      (record.acceptanceCriteria !== undefined &&
        (!Array.isArray(record.acceptanceCriteria) ||
          record.acceptanceCriteria.some((item) => typeof item !== "string")))
    )
      throw new ContractError("INVALID_ARGUMENT", "Invalid requirement patch");
    if (record.text === undefined && record.acceptanceCriteria === undefined)
      throw new ContractError("INVALID_ARGUMENT", "Provide a requirement change");
    return record as { text?: string; acceptanceCriteria?: string[] };
  }
  if (text === undefined && options.criterion === undefined)
    throw new ContractError("INVALID_ARGUMENT", "Provide --text, --criterion or --file");
  return {
    ...(text !== undefined ? { text } : {}),
    ...(options.criterion !== undefined ? { acceptanceCriteria: criteria } : {}),
  };
}

/**
 * The decision of `--file`: the review contract of the MCP tool, whose project is `--project`
 * (`projectId`, resolved by the caller, only completes the contract check).
 */
function reviewInput(file: Uint8Array, projectId: string): RequirementReviewInput {
  const value = parseStrictJson(file);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractError("INVALID_ARGUMENT", "Review decision must be an object");
  if ("projectId" in value)
    throw new ContractError(
      "INVALID_ARGUMENT",
      "The decision file does not name the project: select it with --project",
    );
  validate("Mcp_testmaster_review_requirements", { ...value, projectId });
  return value as RequirementReviewInput;
}

export function requirementCommands(program: Command, runtime: Runtime): void {
  const group = program.command("requirement");
  runtime.bind(
    group
      .command("normalize")
      .requiredOption("--source-revision <id...>")
      .option("--provider <id>")
      .option("--model <id>"),
    async (rt, _args, options) => ({
      data: await (await rt.app()).requirements.normalize({
        projectId: await rt.project(options),
        sourceRevisionIds: strings(options, "sourceRevision"),
        ...(string(options, "provider") ? { provider: required(options, "provider") } : {}),
        ...(string(options, "model") ? { model: required(options, "model") } : {}),
        signal: rt.controller.signal,
      }),
    }),
  );
  runtime.bind(withPaging(group.command("list"), LIST_PAGE), async (rt, _args, options) => {
    const projectId = await rt.project(options);
    const requirements = await (await rt.app()).requirements.list(projectId);
    return {
      data: await listOrPage(rt, requirements, `requirements:${projectId}`, options),
    };
  });
  runtime.bind(group.command("get <id>"), async (rt, args) => ({
    data: await (await rt.app()).requirements.get(String(args[0])),
  }));
  runtime.bind(
    group
      .command("snapshot")
      .description(
        "The current requirement snapshot: version (the review and adjudicate --expected-version), sourceSnapshotId, every requirement with its status, and the conflicts (resolution null until adjudicated)",
      ),
    async (rt, _args, options) => {
      const snapshot = (await rt.app()).requirements.snapshot(await rt.project(options));
      return {
        data: {
          version: snapshot.version,
          sourceSnapshotId: snapshot.fingerprint,
          requirements: snapshot.requirements.map((item) =>
            withRequirementStatus(item, snapshot.conflicts),
          ),
          conflicts: snapshot.conflicts,
          openQuestions: snapshot.openQuestions,
        },
      };
    },
  );
  runtime.bind(
    group
      .command("update <id>")
      .option("--text <text>")
      .option("--criterion <text>", "Replacement criterion (repeatable)", collect)
      .option("--file <path>")
      .option(
        "--reason <text>",
        "Why it is edited (1-2000 characters), recorded with the reviewer and time",
      )
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).requirements.update(
        String(args[0]),
        await patch(rt, options),
        version(options),
        string(options, "reason"),
      ),
    }),
    async (rt, _args, options) => {
      await patch(rt, options);
      version(options);
      return { data: null };
    },
  );
  runtime.bind(
    group
      .command("approve <id>")
      .option(
        "--reason <text>",
        "Why it is approved (1-2000 characters), recorded with the reviewer and time",
      )
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).requirements.approve(
        String(args[0]),
        version(options),
        string(options, "reason"),
      ),
    }),
    (_rt, args, options) => {
      const id = String(args[0]);
      const expectedVersion = version(options);
      return dryRunReport(
        [
          {
            operation: "requirement.approve",
            requirementId: id,
            expectedVersion,
            resultingVersion: expectedVersion + 1,
            records: "an approval for the current principal, audited as requirement.approved",
          },
        ],
        [
          `requirement ${id} must still be at version ${expectedVersion}`,
          "the requirement must have no unresolved conflict",
          "the project must have an environment",
        ],
      );
    },
  );
  runtime.bind(
    group
      .command("reject <id>")
      .requiredOption("--reason <text>", "Why it is out of scope (recorded, mandatory)")
      .requiredOption("--expected-version <version>", "Current version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).requirements.reject(
        String(args[0]),
        required(options, "reason"),
        version(options),
      ),
    }),
    (_rt, args, options) => {
      const id = String(args[0]);
      const expectedVersion = version(options);
      required(options, "reason");
      return dryRunReport(
        [
          {
            operation: "requirement.reject",
            requirementId: id,
            expectedVersion,
            resultingVersion: expectedVersion + 1,
            records: "the reason and reviewer on the requirement, audited as requirement.rejected",
          },
        ],
        [
          `requirement ${id} must still be at version ${expectedVersion}`,
          "the requirement must not be rejected already",
        ],
      );
    },
  );
  runtime.bind(
    group
      .command("adjudicate <conflict-id>")
      .requiredOption(
        "--selected-requirement <id>",
        "Requirement that stands; the conflict's other requirements are superseded and never planned",
      )
      .requiredOption("--reason <text>", "Why this requirement stands (recorded)")
      .requiredOption("--expected-version <version>", "Normalization version", integer),
    async (rt, args, options) => ({
      data: await (await rt.app()).requirements.adjudicate(await rt.project(options), {
        conflictId: String(args[0]),
        selectedRequirementId: required(options, "selectedRequirement"),
        reason: required(options, "reason"),
        expectedVersion: version(options),
      }),
    }),
  );
  runtime.bind(
    group
      .command("review")
      .description(
        "Apply one combined, versioned review decision from --file (edits, conflict decisions, rejections, approvals, in that order)",
      )
      .requiredOption(
        "--file <path>",
        "JSON decision: expectedVersion (the requirement snapshot version), and any of update, adjudicate, reject, approve and reason; `--example` prints one",
      ),
    async (rt, _args, options) => {
      const projectId = await rt.project(options);
      const input = reviewInput(await rt.readInput(required(options, "file")), projectId);
      const receipt = (await rt.app()).requirements.applyReview(projectId, input);
      return {
        data: receipt,
        warnings: receipt.results
          .filter((item) => !item.ok)
          .map(
            (item) =>
              `${item.action} ${item.id} refused: ${item.error?.code}: ${item.error?.message}`,
          ),
      };
    },
    async (rt, _args, options) => {
      const input = reviewInput(
        await rt.readInput(required(options, "file")),
        // Only the contract check needs a project here: a dry run opens no application.
        "prj_00000000-0000-4000-8000-000000000000",
      );
      return dryRunReport(
        [
          {
            operation: "requirement.review",
            expectedVersion: input.expectedVersion,
            edits: input.update?.length ?? 0,
            conflictDecisions: input.adjudicate?.length ?? 0,
            rejections: input.reject?.length ?? 0,
            approvals: input.approve?.length ?? 0,
            records:
              "each decision audited and logged on its requirement; the snapshot version and fingerprint move once per applied decision",
          },
        ],
        [
          `the requirement snapshot must still be at version ${input.expectedVersion}`,
          "every cited requirement and conflict must exist in the project",
        ],
      );
    },
  );
}
