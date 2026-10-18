import { createHash } from "node:crypto";
import { SignedCursorCodec } from "@testmaster/application";
import { ContractError } from "@testmaster/contracts";
import type { Command } from "commander";
import { integer, type Options, type Runtime, string } from "./runtime.js";

/** One page of an ordered list: `nextCursor` is null only on the last page. */
export interface Page<T> {
  total: number;
  returned: number;
  items: T[];
  nextCursor: string | null;
}

/**
 * Adds `--limit` and `--cursor`. A list is paged only when either is given, so its unpaged output
 * stays what it was. `pageSize` is the size the MCP resource of the same list serves, named in the
 * help as the size to ask for.
 */
export function withPaging(command: Command, pageSize: number): Command {
  return command
    .option(
      "--limit <count>",
      `Page size; the output then says total and nextCursor (the MCP resource of this list serves ${pageSize} a page)`,
      integer,
    )
    .option(
      "--cursor <cursor>",
      "The nextCursor of the previous page; the next page has that page's size unless --limit says another",
    );
}

/** Whether the command asked for a page. */
export function isPaged(options: Options): boolean {
  return typeof options.limit === "number" || string(options, "cursor") !== undefined;
}

/**
 * The page `--limit`/`--cursor` select from an ordered list. The cursor is signed, expires, and is
 * bound to `binding` (the list and its filters) and to the acting principal, so another list or
 * caller refuses it; it carries the page size, so `--cursor` alone continues a walk. Every item is
 * on exactly one page of a walk and `nextCursor` says whether more follow.
 */
export async function pageOf<T>(
  rt: Runtime,
  items: readonly T[],
  binding: string,
  options: Options,
): Promise<Page<T>> {
  const app = await rt.app();
  const codec = new SignedCursorCodec(app);
  const bound = `cli:${binding}:${app.context.principalId}`;
  const supplied = string(options, "cursor");
  let offset = 0;
  let limit = typeof options.limit === "number" ? options.limit : undefined;
  if (supplied !== undefined) {
    const cursor = codec.decode(supplied, bound);
    offset = Number(cursor.id);
    limit ??= Number(cursor.cutoff);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length)
      throw new ContractError("INVALID_ARGUMENT", "Invalid cursor");
  }
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1)
    throw new ContractError("INVALID_ARGUMENT", "--limit is required to start a page");
  const end = Math.min(offset + limit, items.length);
  return {
    total: items.length,
    returned: end - offset,
    items: items.slice(offset, end),
    nextCursor:
      end < items.length
        ? codec.encode({ binding: bound, id: String(end), createdAt: "", cutoff: String(limit) })
        : null,
  };
}

/**
 * A list command's data: the whole list as before, or its page when `--limit` or `--cursor` is
 * given. The unpaged form is what a walk of pages adds up to.
 */
export async function listOrPage<T>(
  rt: Runtime,
  items: readonly T[],
  binding: string,
  options: Options,
): Promise<readonly T[] | Page<T>> {
  return isPaged(options) ? pageOf(rt, items, binding, options) : items;
}

/** What `--out` leaves on stdout in place of the document. */
export interface OutReceipt {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Writes `document` to the new file `path` as compact JSON and one newline (what the command
 * prints without `--out`, so `JSON.parse` of the file equals that data) and returns the receipt.
 */
export async function writeJsonOut(
  rt: Runtime,
  path: string,
  document: unknown,
): Promise<OutReceipt> {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  try {
    return {
      path: await rt.writeOutput(path, bytes),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("INVALID_ARGUMENT", "--out must name a file that does not exist", {
      field: "out",
      reason: (error as NodeJS.ErrnoException).code ?? "unwritable",
    });
  }
}

/** The description of an `--out` option that replaces a document with its receipt. */
export const OUT_DESCRIPTION =
  "Write the whole document to this new file (compact JSON) and print only its path, bytes and sha256";
