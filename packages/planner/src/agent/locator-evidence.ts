import { type Locator, validate } from "@testmaster/contracts";
import { canonicalJson, semanticHash } from "@testmaster/domain";

export interface LocatorCandidate {
  role: string;
  name: string;
  tag: string;
  type: string;
  attributes: Record<string, string>;
  fingerprint: string;
  matched: boolean;
  visible: boolean;
}
export interface LocatorEvidence {
  schemaVersion: "1.0.0";
  stepId: string;
  phase: "before" | "after";
  frameOrigin: string;
  locator: Locator;
  cardinality: number;
  candidates: LocatorCandidate[];
  truncated: boolean;
  state: null | {
    requested: "attached" | "visible" | "hidden" | "detached";
    deadlineMs: number;
    transitions: { elapsedMs: number; attached: boolean; visible: boolean; hidden: boolean }[];
  };
  evidenceHash: string;
}
export interface LocatorAssessment {
  equivalent: boolean;
  reasons: string[];
}

/** Hooks and CSS identities may drift; business identity must not. No input values or DOM text. */
export function locatorFingerprint(
  candidate: Pick<LocatorCandidate, "role" | "name" | "tag" | "type" | "attributes">,
): string {
  const attributes = Object.fromEntries(
    ["name", "autocomplete", "aria-haspopup", "data-semantic"]
      .filter((key) => candidate.attributes[key] !== undefined)
      .map((key) => [key, candidate.attributes[key]]),
  );
  return semanticHash({
    role: candidate.role,
    name: candidate.name,
    tag: candidate.tag,
    type: candidate.type,
    attributes,
  });
}
function valid(record: LocatorEvidence): boolean {
  try {
    const { evidenceHash, ...payload } = record;
    validate("Locator", record.locator);
    return (
      record.schemaVersion === "1.0.0" &&
      !record.truncated &&
      Number.isInteger(record.cardinality) &&
      record.cardinality >= 0 &&
      record.candidates.length <= 100 &&
      semanticHash(payload) === evidenceHash &&
      record.candidates.filter((candidate) => candidate.matched).length === record.cardinality &&
      record.candidates.every(
        (candidate) =>
          typeof candidate.matched === "boolean" &&
          typeof candidate.visible === "boolean" &&
          [candidate.role, candidate.name, candidate.tag, candidate.type].every(
            (value) => typeof value === "string" && value.length <= 200,
          ) &&
          Object.entries(candidate.attributes).every(
            ([key, value]) =>
              key !== "value" &&
              !/token|secret|password|authorization|cookie|^on/iu.test(key) &&
              typeof value === "string" &&
              value.length <= 200,
          ) &&
          candidate.fingerprint === locatorFingerprint(candidate),
      )
    );
  } catch {
    return false;
  }
}
function selects(locator: Locator, element: LocatorCandidate): boolean {
  if (locator.container || locator.frame || locator.pageAlias) return false;
  if (locator.by === "role") {
    const { role, name, exact } = locator as Locator & {
      role: string;
      name?: string;
      exact?: boolean;
    };
    return (
      element.visible &&
      role === element.role &&
      (name === undefined || (exact === true ? element.name === name : element.name.includes(name)))
    );
  }
  const { value, exact } = locator as Locator & { value: string; exact?: boolean };
  switch (locator.by) {
    case "testId":
      return element.attributes["data-testid"] === value;
    case "label":
      return exact === true && element.attributes["aria-label"] === value;
    case "placeholder":
      return exact === true && element.attributes.placeholder === value;
    case "css": {
      // Only selectors whose entire semantics are recorded can be proved without a browser.
      const id = /^#([a-zA-Z_][a-zA-Z0-9_-]*)$/u.exec(value);
      if (id) return element.attributes.id === id[1];
      const attribute = /^\[([a-zA-Z_][a-zA-Z0-9_.:-]*)="([^"\\]*)"\]$/u.exec(value);
      return attribute !== null && element.attributes[attribute[1]!] === attribute[2];
    }
    default:
      return false;
  }
}
export function assessLocatorEquivalence(
  baseline: LocatorEvidence[],
  failed: LocatorEvidence[],
  stepId: string,
  candidate: Locator,
): LocatorAssessment {
  const bases = baseline.filter((record) => record.stepId === stepId && record.phase === "before");
  if (!bases.length)
    return { equivalent: false, reasons: ["No previously passing baseline evidence"] };
  const failures = failed.filter((record) => record.stepId === stepId && record.phase === "before");
  for (const base of bases) {
    if (
      !valid(base) ||
      base.cardinality !== 1 ||
      base.locator.frame ||
      base.locator.container ||
      base.locator.pageAlias
    )
      continue;
    const matched = base.candidates.filter((element) => element.matched);
    if (matched.length !== 1) continue;
    const original = matched[0]!;
    if (
      base.candidates.filter((element) => element.fingerprint === original.fingerprint).length !== 1
    )
      continue;
    if (!original.role || !original.name || original.name.includes("[REDACTED]")) continue;
    for (const failure of failures) {
      if (
        !valid(failure) ||
        failure.cardinality !== 0 ||
        failure.candidates.some((element) => element.matched) ||
        !base.frameOrigin ||
        base.frameOrigin === "null" ||
        base.frameOrigin !== failure.frameOrigin ||
        canonicalJson(base.locator) !== canonicalJson(failure.locator)
      )
        continue;
      if (
        failed.some(
          (record) =>
            record.stepId === stepId &&
            canonicalJson(record.locator) === canonicalJson(failure.locator) &&
            (!valid(record) || record.cardinality !== 0),
        )
      )
        continue;
      const equivalents = failure.candidates.filter(
        (element) => element.fingerprint === original.fingerprint,
      );
      const selected = failure.candidates.filter((element) => selects(candidate, element));
      if (equivalents.length === 1 && selected.length === 1 && selected[0] === equivalents[0])
        return {
          equivalent: true,
          reasons: ["Unique recorded semantic identity and replacement locator match"],
        };
    }
  }
  return {
    equivalent: false,
    reasons: [
      "Missing complete unique semantic identity, original absence, or provable replacement selection",
    ],
  };
}
export function waitStateEquivalence(
  baseline: LocatorEvidence[],
  failed: LocatorEvidence[],
  stepId: string,
  newState: "attached" | "visible" | "hidden" | "detached",
): LocatorAssessment {
  const bases = baseline.filter(
    (record) => record.stepId === stepId && record.phase === "after" && record.state,
  );
  if (!bases.length)
    return { equivalent: false, reasons: ["No previously passing wait baseline evidence"] };
  for (const base of bases)
    for (const failure of failed) {
      if (
        failure.stepId !== stepId ||
        failure.phase !== "after" ||
        !base.state ||
        !failure.state ||
        !valid(base) ||
        !valid(failure) ||
        base.frameOrigin === "null" ||
        !base.frameOrigin ||
        base.frameOrigin !== failure.frameOrigin ||
        canonicalJson(base.locator) !== canonicalJson(failure.locator) ||
        base.state.deadlineMs !== failure.state.deadlineMs ||
        !(base.state.deadlineMs > 0) ||
        base.state.requested !== "detached" ||
        failure.state.requested !== "detached" ||
        newState !== "hidden"
      )
        continue;
      if (
        [base, failure].some(
          (record) =>
            !record.state!.transitions.every(
              (state, index, all) =>
                Number.isFinite(state.elapsedMs) &&
                state.elapsedMs >= 0 &&
                (index === 0 || state.elapsedMs >= all[index - 1]!.elapsedMs) &&
                state.hidden === !state.visible &&
                (!state.visible || state.attached),
            ),
        )
      )
        continue;
      const baselineReady = base.state.transitions.some(
        (state) => !state.attached && state.elapsedMs <= base.state!.deadlineMs,
      );
      const failedWasVisible = failure.state.transitions.some(
        (state) => state.attached && state.visible,
      );
      const hidden = failure.state.transitions.some(
        (state, index, all) =>
          state.attached &&
          state.hidden &&
          state.elapsedMs <= failure.state!.deadlineMs &&
          all.slice(0, index).some((previous) => previous.visible),
      );
      const remainedAttached =
        failure.state.transitions.length >= 2 &&
        failure.state.transitions.every((state) => state.attached);
      const matchedBase = base.candidates.filter((element) => element.matched);
      const matchedFailed = failure.candidates.filter((element) => element.matched);
      const baselineBefore = baseline.find(
        (record) =>
          record.stepId === stepId &&
          record.phase === "before" &&
          canonicalJson(record.locator) === canonicalJson(base.locator) &&
          valid(record) &&
          record.cardinality === 1,
      );
      const baselineElement = baselineBefore?.candidates.filter((element) => element.matched);
      // The detached baseline has no final matched node; bind the failed spinner to its initial identity.
      if (
        baselineReady &&
        failedWasVisible &&
        hidden &&
        remainedAttached &&
        baselineElement?.length === 1 &&
        base.cardinality === 0 &&
        matchedBase.length === 0 &&
        failure.cardinality === 1 &&
        matchedFailed.length === 1 &&
        baselineBefore?.frameOrigin === failure.frameOrigin &&
        baselineElement[0]!.fingerprint === matchedFailed[0]!.fingerprint &&
        baselineBefore!.candidates.filter(
          (element) => element.fingerprint === baselineElement[0]!.fingerprint,
        ).length === 1 &&
        failure.candidates.filter(
          (element) => element.fingerprint === matchedFailed[0]!.fingerprint,
        ).length === 1 &&
        !base.locator.frame &&
        !base.locator.container &&
        !base.locator.pageAlias
      )
        return {
          equivalent: true,
          reasons: [
            "Same readiness control became hidden within the unchanged deadline instead of detaching",
          ],
        };
    }
  return {
    equivalent: false,
    reasons: ["No recorded equivalent readiness transition within an unchanged deadline"],
  };
}
