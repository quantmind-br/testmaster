import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { readUrlState, type UrlSchema, type UrlValues, writeUrlState } from "../lib/url-state";

/**
 * Filters, sort and search persisted in the query string. Updates replace the history entry, so
 * Back leaves the page instead of stepping through every keystroke. `schema` must be module-level.
 */
export function useUrlState<S extends UrlSchema>(
  schema: S,
): [UrlValues<S>, (patch: Partial<UrlValues<S>>) => void] {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => readUrlState(schema, params), [schema, params]);
  const update = useCallback(
    (patch: Partial<UrlValues<S>>) =>
      setParams((current) => writeUrlState(schema, current, patch), { replace: true }),
    [schema, setParams],
  );
  return [values, update];
}
