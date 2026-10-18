import type { ReactNode } from "react";
import { StatusView } from "../../components/view-state";
import { useResource } from "../../hooks/use-resource";
import type { ProjectSummary } from "../../routes/home";

interface Usage {
  readonly calls: readonly unknown[];
  readonly storageBytes: number;
  readonly measuredTokens: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

const numberFormat = new Intl.NumberFormat("en-US");

/** Measured model usage and evidence storage of one project. Nothing limits it. */
export function UsageSection({ project }: { project: ProjectSummary }): ReactNode {
  const usage = useResource<Usage>("/usage", { projectId: project.id });
  return (
    <section aria-labelledby="usage-heading" className="settings-section">
      <h2 id="usage-heading">Model usage</h2>
      <StatusView status={usage.status} error={usage.error} onRetry={() => void usage.reload()}>
        {usage.data ? (
          <dl className="context" aria-label="Current usage">
            <dt>Model calls recorded</dt>
            <dd>{usage.data.calls.length}</dd>
            <dt>Input tokens measured</dt>
            <dd>{numberFormat.format(usage.data.measuredTokens.inputTokens)}</dd>
            <dt>Output tokens measured</dt>
            <dd>{numberFormat.format(usage.data.measuredTokens.outputTokens)}</dd>
            <dt>Artifact storage</dt>
            <dd>{numberFormat.format(usage.data.storageBytes)} bytes</dd>
          </dl>
        ) : null}
      </StatusView>
    </section>
  );
}
