/** Node.js majors this release is built, tested and installed for (engines in package.json). */
export const SUPPORTED_NODE_RANGE = ">=24 <25";

export interface NodeSupport {
  supported: boolean;
  required: typeof SUPPORTED_NODE_RANGE;
  actual: string;
}

/** Judges a `process.versions.node` style string; anything that is not a 24.x release is unsupported. */
export function nodeSupport(version: string): NodeSupport {
  return {
    supported: /^24(?:\.|$)/u.test(version),
    required: SUPPORTED_NODE_RANGE,
    actual: version,
  };
}

/** True when the name is a timezone ICU resolves (IANA identifiers and UTC). */
export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
