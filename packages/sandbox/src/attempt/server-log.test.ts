import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../docker/executor.js";
import { captureServerLog, SERVER_LOG_UNAVAILABLE, type ServerLogReader } from "./server-log.js";

const since = new Date("2026-10-17T12:00:00.000Z");
const until = new Date("2026-10-17T12:00:05.000Z");
const capture = { kind: "docker" as const, container: "searxng-tm-app", maxBytes: 10485760 };

function result(stdout: string, stderr = "", code = 0, droppedBytes = 0): CommandResult {
  return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), droppedBytes };
}

describe("captureServerLog", () => {
  it("reads the attempt window and merges both streams in timestamp order", async () => {
    const read = vi.fn<ServerLogReader>(async () =>
      result(
        "2026-10-17T12:00:01.000000000Z GET /search 200\n2026-10-17T12:00:03.000000000Z GET /search?format=csv 500\n",
        "2026-10-17T12:00:02.500000000Z Traceback (most recent call last):\n2026-10-17T12:00:02.600000000Z AttributeError: 'NoneType' object has no attribute 'netloc'\n",
      ),
    );
    const text = await captureServerLog(capture, since, until, read);
    expect(read).toHaveBeenCalledWith("searxng-tm-app", since, until);
    expect(text.split("\n")).toEqual([
      "testmaster: docker logs searxng-tm-app from 2026-10-17T12:00:00.000Z to 2026-10-17T12:00:05.000Z",
      "2026-10-17T12:00:01.000000000Z GET /search 200",
      "2026-10-17T12:00:02.500000000Z Traceback (most recent call last):",
      "2026-10-17T12:00:02.600000000Z AttributeError: 'NoneType' object has no attribute 'netloc'",
      "2026-10-17T12:00:03.000000000Z GET /search?format=csv 500",
      "",
    ]);
  });

  it("keeps the last whole lines within maxBytes and reports the bytes it cut", async () => {
    const lines = Array.from(
      { length: 10 },
      (_, index) => `2026-10-17T12:00:0${index % 5}.00000000${index}Z line ${index}`,
    );
    const text = await captureServerLog({ ...capture, maxBytes: 100 }, since, until, async () =>
      result(`${lines.join("\n")}\n`, "", 0, 7),
    );
    const [header, ...body] = text.trimEnd().split("\n");
    expect(Buffer.byteLength(body.join("\n"))).toBeLessThanOrEqual(100);
    // Every kept line is whole and the newest line is kept.
    expect(body.every((line) => lines.includes(line))).toBe(true);
    expect(body.at(-1)).toBe(lines.at(-1));
    const kept = Buffer.byteLength(body.join("\n"));
    const all = Buffer.byteLength(lines.join("\n"));
    expect(header).toContain(`; the first ${all - kept + 7} bytes were cut`);
  });

  it("masks host secrets and default secret patterns in the stored text", async () => {
    const text = await captureServerLog(
      capture,
      since,
      until,
      async () =>
        result(
          "2026-10-17T12:00:01.000000000Z login admin key hunter2-host-secret ok\n2026-10-17T12:00:02.000000000Z Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
        ),
      ["hunter2-host-secret"],
    );
    expect(text).not.toContain("hunter2-host-secret");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).toContain("login admin");
  });

  it("records why the log is unavailable instead of failing", async () => {
    const failed = await captureServerLog(capture, since, until, async () =>
      result("", "Error response from daemon: No such container: searxng-tm-app", 1),
    );
    expect(failed).toBe(
      `${SERVER_LOG_UNAVAILABLE} (docker logs searxng-tm-app from 2026-10-17T12:00:00.000Z to 2026-10-17T12:00:05.000Z): docker exited 1: Error response from daemon: No such container: searxng-tm-app\n`,
    );
    const thrown = await captureServerLog(capture, since, until, async () => {
      throw new Error("spawn docker ENOENT");
    });
    expect(thrown).toMatch(/^testmaster: server log unavailable \(.*\): spawn docker ENOENT\n$/u);
  });

  it("never passes a name docker could read as an option", async () => {
    const read = vi.fn<ServerLogReader>();
    const text = await captureServerLog({ ...capture, container: "--since=0" }, since, until, read);
    expect(read).not.toHaveBeenCalled();
    expect(text).toContain("invalid container name");
  });
});
