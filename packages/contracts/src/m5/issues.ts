import { Type } from "@sinclair/typebox";
import * as P from "../primitives.js";

/** A Jira or Linear issue key: the project or team key, a hyphen and the issue number. */
export const IssueKey = Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,9}$" });

/**
 * The exact content an executed IssueLink sends (ADR-034): the issue a `create` files and the
 * remote link both kinds attach. The preview hashes this object; execution sends it unchanged.
 */
export const IssuePayload = P.Obj({
  title: P.Name,
  body: P.Description,
  labels: Type.Array(P.Name, { maxItems: 10, uniqueItems: true }),
  link: P.Obj({
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    title: P.Name,
  }),
});
