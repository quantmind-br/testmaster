import { terminalNamedKeys } from "@testmaster/contracts";

const functionKeys: Readonly<Record<string, string>> = {
  F1: "\u001bOP",
  F2: "\u001bOQ",
  F3: "\u001bOR",
  F4: "\u001bOS",
  F5: "\u001b[15~",
  F6: "\u001b[17~",
  F7: "\u001b[18~",
  F8: "\u001b[19~",
  F9: "\u001b[20~",
  F10: "\u001b[21~",
  F11: "\u001b[23~",
  F12: "\u001b[24~",
};
const cursorKeys: Readonly<Record<string, string>> = { Up: "A", Down: "B", Right: "C", Left: "D" };
const homeEndKeys: Readonly<Record<string, string>> = { Home: "H", End: "F" };
const fixedKeys: Readonly<Record<string, string>> = {
  Enter: "\r",
  Tab: "\t",
  "Shift+Tab": "\u001b[Z",
  Backspace: "\u007f",
  Delete: "\u001b[3~",
  Escape: "\u001b",
  Space: " ",
  PageUp: "\u001b[5~",
  PageDown: "\u001b[6~",
  Insert: "\u001b[2~",
};

/**
 * Bytes a physical terminal sends for a key. Cursor and Home/End keys follow DECCKM, which the
 * program toggles; the caller passes the emulator's current mode.
 */
export function encodeKey(key: string, applicationCursor: boolean): string {
  const final = cursorKeys[key] ?? homeEndKeys[key];
  if (final !== undefined) return `${applicationCursor ? "\u001bO" : "\u001b["}${final}`;
  const fixed = fixedKeys[key] ?? functionKeys[key];
  if (fixed !== undefined) return fixed;
  const control = /^Ctrl\+([A-Z])$/u.exec(key)?.[1];
  if (control) return String.fromCharCode(control.charCodeAt(0) - 64);
  const alt = /^Alt\+([A-Za-z0-9])$/u.exec(key)?.[1];
  if (alt) return `\u001b${alt}`;
  throw new Error(`Unsupported terminal key: ${key}`);
}
export const supportedNamedKeys: ReadonlySet<string> = new Set(terminalNamedKeys);
