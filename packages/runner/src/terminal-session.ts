import { constants as osConstants } from "node:os";
import pty, { type IPty } from "@lydell/node-pty";
import xtermHeadless, { type Terminal as XTerminal } from "@xterm/headless";
import { encodeKey } from "./terminal-keys.js";
import { signalGroup } from "./terminal-processes.js";

const { Terminal } = xtermHeadless;
const CAST_LIMIT_BYTES = 4 * 1024 ** 2;
const CLIPBOARD_LIMIT_BYTES = 1024 ** 2;
const BURST_MS = 100;
/** Answers to terminal queries a TUI sends before drawing (OSC 10/11 foreground and background). */
const COLOR_REPLY = {
  10: "\u001b]10;rgb:e5e5/e5e5/e5e5\u001b\\",
  11: "\u001b]11;rgb:0000/0000/0000\u001b\\",
} as const;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SessionOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}
export interface ScreenSnapshot {
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  buffer: "normal" | "alternate";
  lines: string[];
}
type CastEvent = [time: number, type: "o" | "i" | "r" | "m", data: string];
export interface Osc52Entry {
  selection: string;
  text: string;
}

/** One PTY program whose output feeds a headless terminal emulator, the single source of screen truth. */
export class TerminalSession {
  readonly pid: number;
  exitCode: number | null = null;
  signal: string | null = null;
  /** True once the program has exited and the emulator consumed everything it wrote. */
  done = false;
  readonly exited: Promise<void>;
  readonly osc52: Osc52Entry[] = [];
  private readonly term: XTerminal;
  private readonly process: IPty;
  private readonly startedAt = performance.now();
  private readonly events: CastEvent[] = [];
  private castBytes = 0;
  private castTruncated = false;
  private tail: Promise<void> = Promise.resolve();
  private cols: number;
  private rows: number;
  private clipboardText: string | undefined;

  constructor(private readonly options: SessionOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.term = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.process = pty.spawn(options.file, options.args, {
      name: options.env.TERM ?? "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    this.pid = this.process.pid;
    this.term.parser.registerOscHandler(52, (data) => {
      this.captureClipboard(data);
      return true;
    });
    for (const code of [10, 11] as const)
      this.term.parser.registerOscHandler(code, (data) => {
        if (data === "?") this.reply(COLOR_REPLY[code]);
        return true;
      });
    // A real terminal answers device queries (DSR, DA, ...) on the same line the program reads.
    this.term.onData((data) => this.reply(data));
    this.term.onBinary((data) => this.reply(Buffer.from(data, "binary")));
    this.process.onData((data) => {
      this.record("o", data);
      this.enqueue((done) => this.term.write(data, done));
    });
    const settled = Promise.withResolvers<void>();
    this.exited = settled.promise;
    this.process.onExit(({ exitCode, signal }) => {
      void (async () => {
        // The last frame can still be in flight when the exit notification arrives.
        await sleep(50);
        await this.sync();
        this.exitCode = signal ? null : exitCode;
        this.signal = signal
          ? (Object.entries(osConstants.signals).find(([, number]) => number === signal)?.[0] ??
            `SIG${signal}`)
          : null;
        this.record("m", signal ? `signal ${this.signal}` : `exit ${exitCode}`);
        this.done = true;
        settled.resolve();
      })();
    });
  }
  get clipboard(): string | undefined {
    return this.clipboardText;
  }
  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }
  private reply(data: string | Buffer): void {
    if (this.done) return;
    try {
      this.process.write(data);
    } catch {
      /* the program is gone; nothing reads the answer */
    }
  }
  private enqueue(operation: (done: () => void) => void): void {
    this.tail = this.tail.then(() => new Promise<void>((resolve) => operation(resolve)));
  }
  private record(type: CastEvent[1], data: string): void {
    if (this.castTruncated) return;
    const size = Buffer.byteLength(data);
    if (this.castBytes + size > CAST_LIMIT_BYTES) {
      this.castTruncated = true;
      this.events.push([this.elapsed(), "m", "cast truncated at the byte limit"]);
      return;
    }
    this.castBytes += size;
    this.events.push([this.elapsed(), type, data]);
  }
  private elapsed(): number {
    return (performance.now() - this.startedAt) / 1000;
  }
  /** OSC 52 never leaves the emulator: the host clipboard is not reachable from a test. */
  private captureClipboard(data: string): void {
    const separator = data.indexOf(";");
    const selection = data.slice(0, Math.max(separator, 0)) || "c";
    const payload = data.slice(separator + 1);
    if (payload === "?" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) return;
    const bytes = Buffer.from(payload, "base64");
    if (bytes.byteLength > CLIPBOARD_LIMIT_BYTES) return;
    this.clipboardText = bytes.toString("utf8");
    this.osc52.push({ selection, text: this.clipboardText });
  }
  /** Resolves once the emulator parsed everything the program wrote so far. */
  sync(): Promise<void> {
    return this.tail;
  }
  write(data: string): void {
    if (this.done) throw new Error("terminal session ended");
    this.record("i", data);
    this.process.write(data);
  }
  async sendKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      // The program may toggle DECCKM in response to the previous key.
      await this.sync();
      this.write(encodeKey(key, this.term.modes.applicationCursorKeysMode));
      // A lone Escape followed at once by another byte would parse as an Alt chord.
      await sleep(key === "Escape" ? 60 : 5);
    }
  }
  resize(cols: number, rows: number): void {
    if (this.done) throw new Error("terminal session ended");
    this.cols = cols;
    this.rows = rows;
    this.record("r", `${cols}x${rows}`);
    this.process.resize(cols, rows);
    this.enqueue((done) => {
      this.term.resize(cols, rows);
      done();
    });
  }
  signalGroup(signal: NodeJS.Signals): boolean {
    return signalGroup(this.pid, signal);
  }
  snapshot(): ScreenSnapshot {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.term.rows; row++)
      // The alternate buffer keeps cells past a narrowed width; only `cols` are on screen.
      lines.push(
        buffer.getLine(buffer.baseY + row)?.translateToString(true, 0, this.term.cols) ?? "",
      );
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      buffer: buffer.type,
      lines,
    };
  }
  /** The viewport, or one physical row of it, with trailing blank lines dropped. */
  screenText(row?: number): string {
    const { lines } = this.snapshot();
    if (row !== undefined) return lines[row] ?? "";
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") end--;
    return lines.slice(0, end).join("\n");
  }
  /** Scrollback plus viewport of the normal buffer, wrapped rows rejoined. */
  outputText(): string {
    const buffer = this.term.buffer.normal;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true, 0, this.term.cols);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
  /** asciicast v2; output bursts are merged so redaction sees a secret that was split across reads. */
  cast(scrub: (text: string) => string): string {
    const lines = [
      JSON.stringify({
        version: 2,
        width: this.options.cols,
        height: this.options.rows,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    ];
    let burst: CastEvent | undefined;
    let last = 0;
    const flush = (): void => {
      if (burst)
        lines.push(
          JSON.stringify([round(burst[0]), "o", scrub(scrubClipboardSequences(burst[2], scrub))]),
        );
      burst = undefined;
    };
    for (const event of this.events) {
      if (event[1] === "o" && burst && event[0] - last < BURST_MS / 1000) {
        burst[2] += event[2];
        last = event[0];
        continue;
      }
      flush();
      if (event[1] === "o") {
        burst = [event[0], "o", event[2]];
        last = event[0];
      } else lines.push(JSON.stringify([round(event[0]), event[1], scrub(event[2])]));
    }
    flush();
    return `${lines.join("\n")}\n`;
  }
  dispose(): void {
    this.term.dispose();
  }
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the OSC 52 escape sequence itself
const OSC52_SEQUENCE = /\u001b\]52;([^;\u0007\u001b]*);([A-Za-z0-9+/]*={0,2})(\u0007|\u001b\\)/gu;
/** A copied secret is base64 on the wire, so a literal match would miss it: scrub the decoded text. */
function scrubClipboardSequences(data: string, scrub: (text: string) => string): string {
  return data.replace(OSC52_SEQUENCE, (_all, selection: string, payload: string, end: string) => {
    const text = Buffer.from(payload, "base64").toString("utf8");
    return `\u001b]52;${selection};${Buffer.from(scrub(text), "utf8").toString("base64")}${end}`;
  });
}
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
