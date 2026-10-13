import type { ReactNode } from "react";
import { Link } from "react-router";
import { ViewState } from "../components/view-state";
import { usePageTitle } from "../hooks/use-page-title";

/**
 * One view for every address that does not resolve to something the caller may see: an unknown
 * path, a missing ID, and an ID in another workspace all render exactly this, so the portal
 * never reveals whether a resource exists.
 */
export function NotFoundPage(): ReactNode {
  usePageTitle("Not found");
  return (
    <>
      <h1>Not found</h1>
      <ViewState kind="not-found" action={<Link to="/">Go to workspace home</Link>} />
    </>
  );
}
