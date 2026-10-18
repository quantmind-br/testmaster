// The harness floor of a session's T1 (PLAN.md §10, `T1`): the prompt tokens the driving agent's
// first request costs WITHOUT any TestMaster surface. omp's own system prompt and built-in tools
// cost more than the 3,000-token T1 threshold before TestMaster adds a byte, so T1 is read as
// `T1 - floor`, the part the TestMaster surface adds. The floor is measured, not estimated: the
// session's own first request is replayed to the same provider and model with the TestMaster
// parts removed (the MCP tool routes and server instructions sections, and the skill's entry in
// the skills list), and the provider's reported prompt_tokens is the floor. One model call per
// session; it has no deadline (premise 1). The answer is read only for its usage.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { reportedUsage } from "./proxy.mjs";

/** Removes the TestMaster surface from omp's system prompt text. */
export function stripSurface(system) {
  return (
    system
      // "## MCP Tool Routes" and "## MCP Server Instructions" run to the next level-2 heading or
      // the end of the prompt.
      .replace(/\n## MCP Tool Routes\n[\s\S]*?(?=\n## (?!MCP )|$)/, "\n")
      .replace(/\n## MCP Server Instructions\n[\s\S]*?(?=\n## |$)/, "\n")
      .replace(/^- testmaster: .*\n/m, "")
      .replace(/<skills>\n<\/skills>\n?/, "")
  );
}

/** Measures the floor of the session in `directory` and writes floor.json. */
export async function measureFloor(directory, { upstream, apiKey }) {
  const requests = join(directory, "model", "requests");
  const first = readdirSync(requests).sort()[0];
  const body = JSON.parse(readFileSync(join(requests, first), "utf8"));
  const system = body.messages[0];
  const text =
    typeof system.content === "string"
      ? system.content
      : system.content.map((part) => part.text).join("");
  const stripped = stripSurface(text);
  const replay = {
    ...body,
    messages: [{ ...system, content: stripped }, ...body.messages.slice(1)],
  };
  const raw = Buffer.from(JSON.stringify(replay));
  const answer = await new Promise((resolve, reject) => {
    const outgoing = request(
      new URL("/v1/chat/completions", upstream),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "content-length": raw.length,
        },
      },
      async (response) => {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(raw);
  });
  const usage = reportedUsage(answer.text);
  const record = {
    request: first,
    systemBytes: Buffer.byteLength(text),
    strippedSystemBytes: Buffer.byteLength(stripped),
    status: answer.status,
    floorPromptTokens: usage.prompt_tokens ?? null,
  };
  writeFileSync(join(directory, "floor.json"), JSON.stringify(record, null, 2));
  return record;
}
