import type { Analysis } from "@testmaster/contracts";

type EvidenceRef = Analysis["facts"][number]["evidenceRefs"][number];
export interface DiagnosisSummary {
  fields: { label: string; text: string }[];
  details: { label: string; text: string }[];
  warning: string | null;
}

function words(value: string): string {
  return value.replace(/_/g, " ");
}
function references(refs: readonly EvidenceRef[]): string {
  if (!refs.length) return "";
  return ` [evidence: ${refs
    .map((ref) => {
      const rawLocation = ref.stepId
        ? `step ${ref.stepId}`
        : (ref.relativePath ??
          ref.artifactId ??
          ref.snapshotId ??
          ref.runId ??
          ref.sourceRevisionId ??
          "record");
      const location = rawLocation.replace(
        /([a-z]{2,4})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})/gi,
        (_id, prefix: string, suffix: string) => `${prefix}_${suffix.slice(-8)}`,
      );
      return `${location}${ref.observationSeq === undefined ? "" : ` observation ${ref.observationSeq}`}${ref.jsonPointer ?? ""}${ref.contentHash ? ` #${ref.contentHash.slice(0, 12)}` : ""}`;
    })
    .join("; ")}]`;
}

/** Presentation only: never infer a cause or eligibility from numeric confidence. */
export function diagnosisSummary(analysis: Analysis): DiagnosisSummary {
  const diagnosis = analysis.diagnosis;
  const observation = diagnosis?.observation;
  const fields = [
    {
      label: "Failure",
      text: observation
        ? observation.summary
        : diagnosis?.conclusion.status === "no_failure"
          ? "No failure observed"
          : "Observation not recorded",
    },
    { label: "Expected", text: observation?.expected ?? "Not recorded" },
    {
      label: "Observed",
      text: `${observation?.observed ?? "Not recorded"}${observation?.absence ? ` (${words(observation.absence)})` : ""}`,
    },
    {
      label: "Conclusion",
      text: diagnosis
        ? `${diagnosis.conclusion.text} (${words(diagnosis.conclusion.status)})`
        : "Layered conclusion not recorded",
    },
    {
      label: "Next step",
      text: diagnosis
        ? diagnosis.nextSteps[0]
          ? `${diagnosis.nextSteps[0].text} (${diagnosis.nextSteps[0].source})`
          : "None recorded"
        : words(analysis.recommendedAction),
    },
    {
      label: "Automatic healing",
      text: diagnosis
        ? `${words(diagnosis.healing.advice)}: ${diagnosis.healing.reason}`
        : "Advice not recorded",
    },
  ];
  const details = [
    ...(observation?.evidenceRefs.length
      ? [{ label: "Observation evidence", text: references(observation.evidenceRefs).trim() }]
      : []),
    ...(diagnosis?.nextSteps[0]?.evidenceRefs.length
      ? [
          {
            label: "Next step evidence",
            text: references(diagnosis.nextSteps[0].evidenceRefs).trim(),
          },
        ]
      : []),
    ...analysis.facts.map((fact) => ({
      label: "Fact",
      text: `${fact.text}${references(fact.evidenceRefs)}`,
    })),
    ...analysis.hypotheses.map((hypothesis) => ({
      label: "Hypothesis",
      text: `${hypothesis.text} (${hypothesis.support ? words(hypothesis.support) : "not established"})${references(hypothesis.supports)}${hypothesis.contradicts.length ? `; contradicting${references(hypothesis.contradicts)}` : ""}`,
    })),
    ...(diagnosis?.alternatives ?? []).map((alternative) => ({
      label: "Alternative (not established)",
      text: `${alternative.text}${references(alternative.evidenceRefs)}`,
    })),
    ...(diagnosis?.nextSteps.slice(1) ?? []).map((step) => ({
      label: "Next step",
      text: `${step.text}${references(step.evidenceRefs)} (${step.source})`,
    })),
    ...(diagnosis?.chain ?? []).map((step) => ({
      label: "Step",
      text: `${step.stepId}: ${step.operation}, ${step.status}; ${step.summary}${step.verifies ? `; verifies ${step.verifies}` : ""}; baseline ${step.baseline}${references(step.evidenceRefs)}`,
    })),
    ...(diagnosis?.evidenceGaps ?? []).map((gap) => ({ label: "Evidence gap", text: gap })),
    ...analysis.limitations.map((limitation) => ({ label: "Limitation", text: limitation })),
  ];
  return {
    fields,
    details,
    warning: diagnosis ? null : "layered diagnosis not recorded for this analysis",
  };
}

export function formatDiagnosisSummary(analysis: Analysis): string {
  const summary = diagnosisSummary(analysis);
  return `${["Diagnosis", ...summary.fields.map((field) => `${field.label}: ${field.text}`), ...(summary.warning ? [`Warning: ${summary.warning}`] : []), ...summary.details.map((detail) => `${detail.label}: ${detail.text}`)].join("\n")}\n`;
}
