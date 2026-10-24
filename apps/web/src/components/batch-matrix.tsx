import type { ReactNode } from "react";
import { Link } from "react-router";
import { useResource } from "../hooks/use-resource";
import { describeRunContext, shortId } from "../lib/batch-view";
import type { BatchMatrix, MatrixCell } from "../lib/matrix";
import { runListBadge } from "../lib/run-facts";
import type { RunRecord } from "../lib/run-types";
import { Icon, StatusBadge } from "./status";
import { UntrustedText } from "./untrusted-text";

/** Names are fetched per row only for small matrices, so a large batch never fans out requests. */
export const maxNamedRows = 25;

const listReset = { listStyle: "none", margin: 0, padding: 0 } as const;

function TestName({ testId, lookup }: { testId: string; lookup: boolean }): ReactNode {
  return lookup ? <LookedUpName testId={testId} /> : <code>{testId}</code>;
}

function LookedUpName({ testId }: { testId: string }): ReactNode {
  const test = useResource<{ name: string }>(`/tests/${encodeURIComponent(testId)}`);
  return (
    <>
      {test.data ? (
        <strong>
          <UntrustedText value={test.data.name} maxLength={120} />
        </strong>
      ) : null}
      <div>
        <code>{testId}</code>
      </div>
    </>
  );
}

function RunEntry({ run }: { run: RunRecord }): ReactNode {
  const context = describeRunContext(run);
  const repetition = run.matrixCell?.repetitionIndex;
  return (
    <li className="matrix-run" data-run-id={run.id}>
      <StatusBadge {...runListBadge(run)} />{" "}
      <Link to={`/runs/${encodeURIComponent(run.id)}`}>
        Run {shortId(run.id)}
        {repetition === undefined ? "" : ` (repetition ${repetition + 1})`}
      </Link>
      <dl className="context">
        <div className="context-row">
          <dt>Browser</dt>
          <dd>
            {context.browser} {context.browserVersion}
          </dd>
        </div>
        <div className="context-row">
          <dt>Runner image</dt>
          <dd>
            <code>{context.runnerImage}</code>
          </dd>
        </div>
        <div className="context-row">
          <dt>Viewport</dt>
          <dd>{context.viewport}</dd>
        </div>
        <div className="context-row">
          <dt>Locale / time zone</dt>
          <dd>
            {context.locale} / {context.timezone}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function Cell({ cell }: { cell: MatrixCell | undefined }): ReactNode {
  if (!cell || cell.runs.length === 0)
    return (
      <span className="badge tone-neutral">
        <Icon shape="slash" />
        <span>Not run</span>
      </span>
    );
  return (
    <ul style={listReset}>
      {cell.runs.map((run) => (
        <RunEntry key={run.id} run={run} />
      ))}
    </ul>
  );
}

/**
 * Tests down, environments across. Every Run of a pair is listed with its own status and the
 * conditions it ran under, so a failure in one cell is never folded into another cell's pass, and a
 * pair without a Run says "Not run" instead of showing an empty cell.
 */
export function MatrixTable({ matrix }: { matrix: BatchMatrix }): ReactNode {
  const lookup = matrix.rows.length <= maxNamedRows;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named scroll region keeps its caption
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll it
    <div className="table-scroll" role="region" aria-label="Batch matrix" tabIndex={0}>
      <table className="data matrix">
        <caption>Batch matrix: tests by environment</caption>
        <thead>
          <tr>
            <th scope="col">Test</th>
            {matrix.columns.map((column) => (
              <th key={column} scope="col">
                <UntrustedText value={column} maxLength={80} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.testId}>
              <th scope="row">
                <TestName testId={row.testId} lookup={lookup} />
              </th>
              {matrix.columns.map((column) => (
                <td key={column}>
                  <Cell cell={row.cells[column]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
