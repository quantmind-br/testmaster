import { randomUUID } from "node:crypto";
import {
  ContractError,
  type IncidentCloseInput,
  type IncidentEventInput,
  type IncidentInput,
  type IncidentView,
  validate,
} from "@testmaster/contracts";
import type { PersistenceDatabase } from "@testmaster/persistence";
import { auditSecurity } from "./audit.js";
import { authoringTransaction } from "./authoring.js";
import type { ServiceContext } from "./context.js";

/**
 * Incident records (OPS-036). The record is append-only: every change is a new `incident_events`
 * row, and the incident row only mirrors the current state. Records never touch Run rows.
 */
interface IncidentRow {
  id: string;
  workspace_id: string;
  created_at: string;
  version: number;
  data_json: string;
  title: string;
  severity: IncidentView["severity"];
  category: IncidentView["category"];
  state: IncidentView["state"];
  closed_at: string | null;
}

interface IncidentData {
  summary: string;
  detectedAt: string;
  versions: string[];
  resources: { type: string; id: string }[];
  openedBy: string;
  dataAffected: IncidentView["dataAffected"];
  resolution: string | null;
}

interface EventRow {
  id: string;
  seq: number;
  created_at: string;
  kind: string;
  actor: string;
  data_json: string;
}

type EvidenceRef = { kind: string; ref: string; sha256?: string | undefined };

const incidentColumns =
  "id,workspace_id,created_at,version,data_json,title,severity,category,state,closed_at";
const urgent: readonly string[] = ["critical", "high"];

/** Evidence kinds that name a record of this workspace and therefore must exist. */
const evidenceTables: Record<string, string> = {
  run: "runs",
  artifact: "artifacts",
  audit_event: "audit_events",
};

function evidenceExists(
  database: PersistenceDatabase,
  workspaceId: string,
  ref: EvidenceRef,
): boolean {
  const table = evidenceTables[ref.kind];
  if (!table) return true;
  return Boolean(
    database.get(
      `SELECT 1 AS found FROM ${table} WHERE workspace_id=? AND id=?`,
      workspaceId,
      ref.ref,
    ),
  );
}

export class IncidentsService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireEvidence(refs: readonly EvidenceRef[]): void {
    const missing = refs.filter(
      (ref) => !evidenceExists(this.ctx.database, this.ctx.workspaceId, ref),
    );
    if (missing.length)
      throw new ContractError(
        "INVALID_ARGUMENT",
        "Evidence reference does not exist in this workspace",
        {
          reasonCode: "evidence_missing",
          missing: missing.map((ref) => `${ref.kind}:${ref.ref}`),
        },
      );
  }

  private row(id: string): IncidentRow {
    const row = this.ctx.database.get<IncidentRow>(
      `SELECT ${incidentColumns} FROM incidents WHERE workspace_id=? AND id=?`,
      this.ctx.workspaceId,
      id,
    );
    if (!row) throw new ContractError("NOT_FOUND", "Incident does not exist", { id });
    return row;
  }

  private events(id: string): EventRow[] {
    return this.ctx.database.all<EventRow>(
      "SELECT id,seq,created_at,kind,actor,data_json FROM incident_events WHERE workspace_id=? AND incident_id=? ORDER BY seq",
      this.ctx.workspaceId,
      id,
    );
  }

  private append(incidentId: string, kind: string, data: Record<string, unknown>): string {
    const seq =
      Number(
        this.ctx.database.get(
          "SELECT COALESCE(MAX(seq),0) AS n FROM incident_events WHERE workspace_id=? AND incident_id=?",
          this.ctx.workspaceId,
          incidentId,
        )?.n ?? 0,
      ) + 1;
    const id = `ine_${randomUUID()}`;
    this.ctx.database.run(
      "INSERT INTO incident_events(workspace_id,id,incident_id,seq,created_at,kind,actor,data_json) VALUES(?,?,?,?,?,?,?,?)",
      this.ctx.workspaceId,
      id,
      incidentId,
      seq,
      new Date().toISOString(),
      kind,
      this.ctx.principalId,
      JSON.stringify(data),
    );
    return id;
  }

  private view(row: IncidentRow): IncidentView {
    const data: IncidentData = JSON.parse(row.data_json);
    const events = this.events(row.id);
    const reach: IncidentView["reach"] = { confirmed: [], suspected: [], unknown: [] };
    const actions = new Map<string, IncidentView["actions"][number]>();
    let communication: IncidentView["communication"]["state"] = "none";
    for (const event of events) {
      const payload = JSON.parse(event.data_json);
      if (event.kind === "reach")
        reach[payload.reach.scope as keyof typeof reach].push(payload.reach);
      else if (event.kind === "action")
        actions.set(event.id, {
          eventId: event.id,
          description: payload.action.description,
          verificationCriterion: payload.action.verificationCriterion,
          owner: payload.action.owner,
          verified: false,
        });
      else if (event.kind === "action_verified") {
        const action = actions.get(payload.actionEventId);
        if (action) action.verified = true;
      } else if (event.kind === "communication") communication = payload.communication.state;
    }
    return validate<IncidentView>("Incident", {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      severity: row.severity,
      category: row.category,
      summary: data.summary,
      state: row.state,
      detectedAt: data.detectedAt,
      versions: data.versions,
      resources: data.resources,
      openedBy: data.openedBy,
      closedAt: row.closed_at,
      dataAffected: data.dataAffected,
      resolution: data.resolution,
      communication: { state: communication },
      reach,
      actions: [...actions.values()],
      timeline: events.map((event) => {
        const payload = JSON.parse(event.data_json);
        const { text, at, ...rest } = payload;
        return {
          id: event.id,
          seq: Number(event.seq),
          kind:
            event.kind === "opened" ? "timeline" : event.kind === "closed" ? "status" : event.kind,
          at: at ?? event.created_at,
          actor: event.actor,
          text: text ?? event.kind,
          data: rest,
        };
      }),
      createdAt: row.created_at,
      version: Number(row.version),
    });
  }

  list(): IncidentView[] {
    this.ctx.authorize("A");
    return this.ctx.database
      .all<IncidentRow>(
        `SELECT ${incidentColumns} FROM incidents WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 200`,
        this.ctx.workspaceId,
      )
      .map((row) => this.view(row));
  }

  get(id: string): IncidentView {
    this.ctx.authorize("A");
    return this.view(this.row(id));
  }

  create(input: IncidentInput): IncidentView {
    validate("IncidentInput", input);
    this.ctx.authorize("A");
    return authoringTransaction(this.ctx, () => {
      const now = new Date().toISOString();
      const id = `inr_${randomUUID()}`;
      const data: IncidentData = {
        summary: input.summary,
        detectedAt: input.detectedAt ?? now,
        versions: input.versions,
        resources: input.resources,
        openedBy: this.ctx.principalId,
        dataAffected: null,
        resolution: null,
      };
      this.ctx.database.run(
        "INSERT INTO incidents(workspace_id,id,created_at,data_json,title,severity,category,state) VALUES(?,?,?,?,?,?,?,'open')",
        this.ctx.workspaceId,
        id,
        now,
        JSON.stringify(data),
        input.title,
        input.severity,
        input.category,
      );
      this.append(id, "opened", { text: input.summary, at: now, ...data });
      auditSecurity(this.ctx, "ops.incident.create", id, "allowed");
      return this.view(this.row(id));
    });
  }

  addEvent(id: string, input: IncidentEventInput): IncidentView {
    this.ctx.authorize("A");
    return authoringTransaction(this.ctx, () => {
      const row = this.row(id);
      if (row.state === "closed")
        throw new ContractError("PRECONDITION_FAILED", "Incident is closed; open a new incident", {
          reasonCode: "incident_closed",
        });
      const events = this.events(id).map((event) => ({
        ...event,
        payload: JSON.parse(event.data_json),
      }));
      const { kind, ...payload } = input;
      if ("evidenceRefs" in input) this.requireEvidence(input.evidenceRefs);
      if (input.kind === "action_verified") {
        const action = events.find(
          (event) => event.kind === "action" && event.id === input.actionEventId,
        );
        if (!action)
          throw new ContractError(
            "INVALID_ARGUMENT",
            "Verified action does not exist in this incident",
            {
              reasonCode: "action_unknown",
            },
          );
        if (
          events.some(
            (event) =>
              event.kind === "action_verified" &&
              event.payload.actionEventId === input.actionEventId,
          )
        )
          throw new ContractError("PRECONDITION_FAILED", "Action is already verified", {
            reasonCode: "action_verified",
          });
      }
      if (input.kind === "communication" && input.communication.state === "public_disclosed") {
        const notified = events.some(
          (event) =>
            event.kind === "communication" &&
            event.payload.communication.state === "private_notified",
        );
        if (!notified)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Affected parties must be notified privately before public disclosure",
            {
              reasonCode: "private_notification_required",
            },
          );
      }
      if (input.kind === "status") {
        if (input.status === "mitigated" && row.state !== "open")
          throw new ContractError("PRECONDITION_FAILED", "Only an open incident can be mitigated", {
            reasonCode: "invalid_transition",
            state: row.state,
          });
        if (input.status === "resumed") {
          if (row.state !== "mitigated")
            throw new ContractError("PRECONDITION_FAILED", "Only a mitigated incident can resume", {
              reasonCode: "invalid_transition",
              state: row.state,
            });
          if (urgent.includes(row.severity)) {
            const gates = input.gates;
            if (!gates?.security.length || !gates.consistency.length)
              throw new ContractError(
                "PRECONDITION_FAILED",
                "Resuming a critical or high incident needs security and consistency gate evidence",
                {
                  reasonCode: "resume_gates_required",
                },
              );
            this.requireEvidence([...gates.security, ...gates.consistency]);
          }
        }
        this.ctx.database.run(
          "UPDATE incidents SET state=?,version=version+1 WHERE workspace_id=? AND id=?",
          input.status,
          this.ctx.workspaceId,
          id,
        );
      }
      this.append(id, kind, { ...payload, at: input.at ?? new Date().toISOString() });
      auditSecurity(this.ctx, `ops.incident.${kind}`, id, "allowed");
      return this.view(this.row(id));
    });
  }

  close(id: string, input: IncidentCloseInput): IncidentView {
    this.ctx.authorize("A");
    return authoringTransaction(this.ctx, () => {
      const row = this.row(id);
      if (row.state === "closed")
        throw new ContractError("PRECONDITION_FAILED", "Incident is already closed", {
          reasonCode: "incident_closed",
        });
      const current = this.view(row);
      if (urgent.includes(row.severity) && row.state !== "resumed")
        throw new ContractError(
          "PRECONDITION_FAILED",
          "A critical or high incident must resume with gate evidence before it closes",
          {
            reasonCode: "resume_gates_required",
          },
        );
      const unverified = current.actions
        .filter((action) => !action.verified)
        .map((action) => action.eventId);
      if (unverified.length)
        throw new ContractError(
          "PRECONDITION_FAILED",
          "Corrective actions need verification before closing",
          {
            reasonCode: "actions_unverified",
            unverified,
          },
        );
      if (input.dataAffected === "none_with_evidence") {
        if (!input.noDataAffectedEvidence.length)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "A no-data-affected claim needs evidence references",
            {
              reasonCode: "no_data_affected_evidence_required",
            },
          );
        if (current.reach.confirmed.length)
          throw new ContractError(
            "PRECONDITION_FAILED",
            "Confirmed reach contradicts a no-data-affected claim",
            {
              reasonCode: "reach_contradicts_claim",
            },
          );
        this.requireEvidence(input.noDataAffectedEvidence);
      }
      const now = new Date().toISOString();
      const data: IncidentData = JSON.parse(row.data_json);
      this.ctx.database.run(
        "UPDATE incidents SET state='closed',closed_at=?,version=version+1,data_json=? WHERE workspace_id=? AND id=?",
        now,
        JSON.stringify({ ...data, dataAffected: input.dataAffected, resolution: input.resolution }),
        this.ctx.workspaceId,
        id,
      );
      this.append(id, "closed", {
        text: input.resolution,
        at: now,
        dataAffected: input.dataAffected,
        noDataAffectedEvidence: input.noDataAffectedEvidence,
      });
      auditSecurity(this.ctx, "ops.incident.close", id, "allowed");
      return this.view(this.row(id));
    });
  }
}
