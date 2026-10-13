import type { ReactNode } from "react";
import { StatusView } from "../../components/view-state";
import { useResource } from "../../hooks/use-resource";

interface Capabilities {
  readonly limits: Readonly<Record<string, unknown>>;
}

interface LimitRow {
  readonly key: string;
  readonly label: string;
  readonly unit: "ms" | "bytes" | "count";
}

const limitRows: readonly LimitRow[] = [
  { key: "concurrency", label: "Concurrent browser executions", unit: "count" },
  { key: "executionTimeoutMs", label: "Whole execution deadline", unit: "ms" },
  { key: "attemptTimeoutMs", label: "Single attempt deadline", unit: "ms" },
  { key: "stepTimeoutMs", label: "Single step deadline", unit: "ms" },
  { key: "networkRequestTimeoutMs", label: "Network request deadline", unit: "ms" },
  { key: "preparationTimeoutMs", label: "Preparation deadline", unit: "ms" },
  { key: "collectionGraceMs", label: "Evidence collection grace", unit: "ms" },
  { key: "analysisGraceMs", label: "Analysis grace", unit: "ms" },
  { key: "maxAttempts", label: "Attempts per run", unit: "count" },
  { key: "bodyBytes", label: "Recorded body size", unit: "bytes" },
  { key: "artifactBytes", label: "Size of one artifact", unit: "bytes" },
  { key: "attemptArtifactBytes", label: "Artifacts per attempt", unit: "bytes" },
  { key: "logBytes", label: "Log size per attempt", unit: "bytes" },
];

const number = new Intl.NumberFormat("en-US");

function formatLimit(value: unknown, unit: LimitRow["unit"]): string {
  if (typeof value !== "number") return "Not reported";
  if (unit === "ms")
    return value >= 1000 ? `${number.format(value / 1000)} s` : `${number.format(value)} ms`;
  if (unit === "bytes")
    return value >= 1024 * 1024
      ? `${number.format(value / (1024 * 1024))} MiB`
      : `${number.format(value)} bytes`;
  return number.format(value);
}

/**
 * The limits that bound runs on this server (UX-056). They are read from the effective execution
 * configuration, so the page shows what is enforced rather than a marketing number.
 */
export function LimitsSection(): ReactNode {
  const capabilities = useResource<Capabilities>("/capabilities");
  return (
    <section aria-labelledby="limits-heading" className="settings-section">
      <h2 id="limits-heading">Limits</h2>
      <p className="hint">
        These limits come from the server's execution configuration. A run that reaches one ends
        with a named reason; it is never reported as passed.
      </p>
      <StatusView
        status={capabilities.status}
        error={capabilities.error}
        onRetry={() => void capabilities.reload()}
      >
        {capabilities.data ? (
          <table>
            <caption>Execution limits (read only)</caption>
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {limitRows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td>{formatLimit(capabilities.data?.limits[row.key], row.unit)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">List page size</th>
                <td>50 by default, 100 at most</td>
              </tr>
            </tbody>
          </table>
        ) : null}
      </StatusView>
    </section>
  );
}
