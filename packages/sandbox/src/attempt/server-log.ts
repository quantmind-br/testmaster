import { scrubEvidenceText } from "@testmaster/domain";
import { type CommandResult, dockerCommand } from "../docker/executor.js";

/**
 * Where an environment's application server writes its log, opted in per environment. Only a
 * docker container for now: its name is the only input, validated against docker's name grammar
 * so it can never be read as a `docker logs` option.
 */
export interface ServerLogCapture {
  kind: "docker";
  container: string;
  /** Bytes of log kept from the end of the attempt window. */
  maxBytes: number;
}
/** Reads the container's log lines written between `since` and `until`, with timestamps. */
export type ServerLogReader = (
  container: string,
  since: Date,
  until: Date,
) => Promise<CommandResult>;

export const DOCKER_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/u;
/** The first line of `logs/server.log` when the log could not be read. */
export const SERVER_LOG_UNAVAILABLE = "testmaster: server log unavailable";

export const dockerServerLogs: ServerLogReader = (container, since, until) =>
  dockerCommand([
    "logs",
    "--timestamps",
    "--since",
    since.toISOString(),
    "--until",
    until.toISOString(),
    "--",
    container,
  ]);

/** A sortable key of the RFC 3339 timestamp `docker logs --timestamps` puts first, or "". */
function timestampKey(line: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z /u.exec(line);
  return match ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}` : "";
}
/** Lines of both streams in timestamp order; a line without a timestamp keeps its predecessor's. */
function merged(result: CommandResult): string[] {
  const lines = [result.stdout, result.stderr].flatMap((stream, origin) =>
    stream
      .toString("utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line, index) => ({ line, origin, index, at: timestampKey(line) })),
  );
  let previous = "";
  for (const item of lines) {
    if (item.at) previous = item.at;
    else item.at = previous;
  }
  return lines
    .sort((a, b) => a.at.localeCompare(b.at) || a.origin - b.origin || a.index - b.index)
    .map((item) => item.line);
}

/**
 * The text of `logs/server.log` for one attempt window: a header line naming the container and
 * the window, then the lines, cut to the last `maxBytes`, with `secrets` and the default secret
 * patterns masked. A read failure never fails the attempt: the text is one line starting with
 * {@link SERVER_LOG_UNAVAILABLE} and the reason.
 */
export async function captureServerLog(
  capture: ServerLogCapture,
  since: Date,
  until: Date,
  read: ServerLogReader = dockerServerLogs,
  secrets: readonly string[] = [],
): Promise<string> {
  return scrubEvidenceText(await serverLogText(capture, since, until, read), [...secrets]).text;
}
async function serverLogText(
  capture: ServerLogCapture,
  since: Date,
  until: Date,
  read: ServerLogReader,
): Promise<string> {
  const window = `docker logs ${capture.container} from ${since.toISOString()} to ${until.toISOString()}`;
  if (!DOCKER_CONTAINER_NAME.test(capture.container))
    return `${SERVER_LOG_UNAVAILABLE} (${window}): invalid container name\n`;
  let result: CommandResult;
  try {
    result = await read(capture.container, since, until);
  } catch (error) {
    return `${SERVER_LOG_UNAVAILABLE} (${window}): ${(error as Error).message.slice(0, 300)}\n`;
  }
  if (result.code !== 0)
    return `${SERVER_LOG_UNAVAILABLE} (${window}): docker exited ${result.code}: ${result.stderr.toString("utf8").trim().slice(0, 300)}\n`;
  let body = merged(result).join("\n");
  let cut = result.droppedBytes;
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > capture.maxBytes) {
    const tail = bytes.subarray(bytes.length - capture.maxBytes).toString("utf8");
    // Start at a whole line.
    const start = tail.indexOf("\n");
    body = start >= 0 ? tail.slice(start + 1) : tail;
    cut += bytes.length - Buffer.byteLength(body, "utf8");
  }
  const header = `testmaster: ${window}${cut ? `; the first ${cut} bytes were cut` : ""}`;
  return `${header}\n${body}${body ? "\n" : ""}`;
}
