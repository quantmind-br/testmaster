export interface ConstraintFixture {
  name: string;
  statements: string[];
  expected: "accept" | "foreign_key" | "unique" | "check";
}
const time = "2026-10-05T00:00:00.000Z";
export const constraintSeed = [
  `INSERT INTO workspaces(workspace_id,id,created_at,name,mode) VALUES('ws-a','ws-a','${time}','A','single-user'),('ws-b','ws-b','${time}','B','single-user')`,
  `INSERT INTO projects(workspace_id,id,created_at,name,slug) VALUES('ws-a','prj-a','${time}','A','a'),('ws-b','prj-b','${time}','B','b')`,
  `INSERT INTO environments(workspace_id,id,created_at,project_id,name,active_revision_id) VALUES('ws-a','env-a','${time}','prj-a','local','evr-a')`,
  `INSERT INTO environment_revisions(workspace_id,id,created_at,environment_id,network_profile,production) VALUES('ws-a','evr-a','${time}','env-a','local-loopback',0)`,
  `INSERT INTO tests(workspace_id,id,created_at,project_id,name) VALUES('ws-a','tst-a','${time}','prj-a','A'),('ws-a','tst-other','${time}','prj-a','Other')`,
  `INSERT INTO test_revisions(workspace_id,id,created_at,test_id,ordinal,content_hash,runner_kind,origin) VALUES('ws-a','rev-a','${time}','tst-a',1,'hash','http','manual')`,
  `INSERT INTO runs(workspace_id,id,created_at,test_id,revision_id,environment_revision_id,mode,phase,status,gate,cleanup_outcome,analysis_status) VALUES('ws-a','run-a','${time}','tst-a','rev-a','evr-a','replay','queued','queued','pending','not_required','not_requested')`,
  `INSERT INTO job_leases(workspace_id,id,created_at,queue,resource_id,available_at) VALUES('ws-a','job-a','${time}','http','run-a','${time}')`,
  `INSERT INTO attempts(workspace_id,id,created_at,run_id,number,phase,job_id,fence,lease_owner) VALUES('ws-a','att-a','${time}','run-a',1,'preparing','job-a',1,'worker-a')`,
  `INSERT INTO snapshots(workspace_id,id,created_at,run_id,attempt_id,revision_id,manifest_hash,committed_at) VALUES('ws-a','snp-a','${time}','run-a','att-a','rev-a','hash','${time}')`,
  `INSERT INTO audit_events(workspace_id,id,created_at,actor,action,resource_id,request_id,timestamp) VALUES('ws-a','aud-a','${time}','user','create','run-a','request','${time}')`,
];
export const constraintFixtures: ConstraintFixture[] = [
  {
    name: "cross-workspace project reference",
    statements: [
      `INSERT INTO tests(workspace_id,id,created_at,project_id,name) VALUES('ws-a','bad','${time}','prj-b','Bad')`,
    ],
    expected: "foreign_key",
  },
  {
    name: "duplicate test ordinal",
    statements: [
      `INSERT INTO test_revisions(workspace_id,id,created_at,test_id,ordinal,content_hash,runner_kind,origin) VALUES('ws-a','rev-duplicate','${time}','tst-a',1,'hash','http','manual')`,
    ],
    expected: "unique",
  },
  {
    name: "duplicate attempt number",
    statements: [
      `INSERT INTO attempts(workspace_id,id,created_at,run_id,number,phase,job_id,fence,lease_owner) VALUES('ws-a','att-duplicate','${time}','run-a',1,'running','job-a',2,'worker-b')`,
    ],
    expected: "unique",
  },
  {
    name: "duplicate plan step",
    statements: [
      `INSERT INTO steps(workspace_id,id,created_at,attempt_id,plan_step_id,step_index,status) VALUES('ws-a','step-a','${time}','att-a','health',0,'passed'),('ws-a','step-b','${time}','att-a','health',1,'passed')`,
    ],
    expected: "unique",
  },
  {
    name: "environment name per project",
    statements: [
      `INSERT INTO environments(workspace_id,id,created_at,project_id,name,active_revision_id) VALUES('ws-a','env-duplicate','${time}','prj-a','local','evr-a')`,
    ],
    expected: "unique",
  },
  {
    name: "outbox aggregate sequence",
    statements: [
      `INSERT INTO outbox(workspace_id,id,created_at,aggregate_id,seq,type,payload_ref) VALUES('ws-a','evt-a','${time}','run-a',0,'finish','payload'),('ws-a','evt-b','${time}','run-a',0,'finish','payload')`,
    ],
    expected: "unique",
  },
  {
    name: "run revision belongs to test",
    statements: ["UPDATE runs SET test_id='tst-other' WHERE id='run-a'"],
    expected: "foreign_key",
  },
  {
    name: "invalid artifact availability",
    statements: [
      `INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,bytes,storage_key,state,redaction_status) VALUES('ws-a','art-bad','${time}','run-a','att-a','rev-a','snp-a',0,'a','available','redacted')`,
    ],
    expected: "check",
  },
  {
    name: "invalid phase",
    statements: ["UPDATE runs SET phase='success' WHERE id='run-a'"],
    expected: "check",
  },
  {
    name: "terminal phase without outcome",
    statements: ["UPDATE runs SET phase='completed',status='passed' WHERE id='run-a'"],
    expected: "check",
  },
  {
    name: "valid terminal and immutable verdict",
    statements: [
      "UPDATE runs SET phase='completed',status='failed',outcome='failed',gate='failed' WHERE id='run-a'",
      "UPDATE runs SET status='passed',outcome='passed' WHERE id='run-a'",
    ],
    expected: "check",
  },
  {
    name: "phase cannot regress",
    statements: [
      "UPDATE runs SET phase='running',status='running' WHERE id='run-a'",
      "UPDATE runs SET phase='preparing',status='preparing' WHERE id='run-a'",
    ],
    expected: "check",
  },
  {
    name: "audit update rejected",
    statements: ["UPDATE audit_events SET action='tamper' WHERE id='aud-a'"],
    expected: "check",
  },
  {
    name: "audit deletion rejected",
    statements: ["DELETE FROM audit_events WHERE id='aud-a'"],
    expected: "check",
  },
  {
    name: "revision bytes immutable",
    statements: ["UPDATE test_revisions SET content_hash='tamper' WHERE id='rev-a'"],
    expected: "check",
  },
  {
    name: "negative artifact bytes",
    statements: [
      `INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,bytes,storage_key,state,redaction_status) VALUES('ws-a','art-bad','${time}','run-a','att-a','rev-a','snp-a',-1,'a','missing','not_applicable')`,
    ],
    expected: "check",
  },
  {
    name: "sensitive variable must have encrypted reference",
    statements: [
      `INSERT INTO variables(workspace_id,id,created_at,producer_run_id,producer_step_id,name,type,taint) VALUES('ws-a','var-a','${time}','run-a','capture','token','string','sensitive')`,
    ],
    expected: "check",
  },
  {
    name: "valid artifact dimensions",
    statements: [
      `INSERT INTO artifacts(workspace_id,id,created_at,run_id,attempt_id,revision_id,snapshot_id,hash,bytes,storage_key,state,redaction_status) VALUES('ws-a','art-ok','${time}','run-a','att-a','rev-a','snp-a','hash',1,'a','available','redacted')`,
    ],
    expected: "accept",
  },
];
export function constraintErrorClass(error: unknown): ConstraintFixture["expected"] {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "23503" || message.includes("foreign key")) return "foreign_key";
  if (
    code === "23505" ||
    message.includes("unique constraint") ||
    message.includes("duplicate key")
  )
    return "unique";
  if (
    code === "23514" ||
    message.includes("check constraint") ||
    message.includes("immutable") ||
    message.includes("phase_regression")
  )
    return "check";
  throw error;
}
