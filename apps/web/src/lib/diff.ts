export type DiffLine =
  | { readonly kind: "same"; readonly text: string }
  | { readonly kind: "added"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string };

export const maxDiffLines = 2_000;

/** Longest-common-subsequence line diff. Returns `null` beyond the size limit. */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > maxDiffLines || b.length > maxDiffLines) return null;
  const table: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i] as Uint32Array;
      const below = table[i + 1] as Uint32Array;
      row[j] =
        a[i] === b[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number);
    }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if (
      ((table[i + 1] as Uint32Array)[j] as number) >= ((table[i] as Uint32Array)[j + 1] as number)
    ) {
      result.push({ kind: "removed", text: a[i++] as string });
    } else result.push({ kind: "added", text: b[j++] as string });
  }
  while (i < a.length) result.push({ kind: "removed", text: a[i++] as string });
  while (j < b.length) result.push({ kind: "added", text: b[j++] as string });
  return result;
}
