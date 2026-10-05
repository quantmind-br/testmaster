import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Application } from "../application.js";

it("requires write scope before filesystem changes and appends audit events without content", async () => {
  const root = await mkdtemp(join(tmpdir(), "tm-agent-service-"));
  const app = await Application.open({ cwd: root, home: root });
  let restricted: Application | undefined;
  try {
    const identity = await app.init();
    restricted = await Application.open({
      cwd: root,
      home: root,
      identity: { principalId: identity.principalId, scopes: ["R"] },
    });
    const preview = await restricted.agentSkills.plan("claude");
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    await expect(restricted.agentSkills.apply(preview.plan)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(readFile(join(root, "CLAUDE.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      app.database
        .all("SELECT * FROM audit_events")
        .filter((row) => String(row.action).startsWith("agent_skills")),
    ).toHaveLength(0);
    const ownPreview = await app.agentSkills.plan("claude");
    if (!ownPreview.ok) throw new Error(JSON.stringify(ownPreview));
    expect(await app.agentSkills.apply(ownPreview.plan)).toMatchObject({ ok: true });
    const events = app.database
      .all("SELECT * FROM audit_events")
      .filter((row) => String(row.action).startsWith("agent_skills"));
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("Read .claude/skills");
    await expect(app.agentSkills.apply(preview.plan)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
  } finally {
    restricted?.close();
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
