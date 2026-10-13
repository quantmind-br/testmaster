import { type ReactNode, useId } from "react";
import type { Impact, ImpactLevel } from "../lib/impact";
import { Icon, type Shape, type Tone } from "./status";

const presentation: Record<ImpactLevel, { tone: Tone; shape: Shape; label: string }> = {
  none: { tone: "neutral", shape: "info", label: "No impact" },
  info: { tone: "info", shape: "info", label: "Note" },
  warning: { tone: "warning", shape: "warn", label: "Review" },
};

/**
 * Shows what a change does to reproducibility, cost and data protection before it is saved.
 * Each row carries a text label and a shape; colour only reinforces.
 */
export function ImpactPanel({
  title = "Impact of this change",
  impacts,
}: {
  title?: string;
  impacts: readonly Impact[];
}): ReactNode {
  const headingId = useId();
  return (
    <section className="impact-panel" aria-labelledby={headingId} data-testid="impact-panel">
      <h3 id={headingId}>{title}</h3>
      <ul>
        {impacts.map((impact) => {
          const view = presentation[impact.level];
          return (
            <li key={impact.area} data-area={impact.area} data-level={impact.level}>
              <span className={`badge tone-${view.tone}`}>
                <Icon shape={view.shape} />
                <span>{view.label}</span>
              </span>{" "}
              <strong>{impact.area}.</strong> {impact.text}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
