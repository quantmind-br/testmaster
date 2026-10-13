# Portal accessibility evidence

Target: WCAG 2.2 AA for TestMaster's own screens (`specs/` §7). Third-party artifact viewers are isolated in sandboxed frames and always have a text, steps or download alternative.

## The sweep

`validation/journeys/portal-accessibility.portal.test.ts` discovers every route from `apps/web/src/routes/index.ts` and, for each one, checks: structure (one `h1`, one `main`, title, language), live regions (no assertive regions, at most one polite region, no focus stolen on load), axe with zero serious or critical violations at desktop size and at 320 px with 200 % zoom, keyboard-only Tab traversal (every control reachable, visible focus ring, no trap, no positive `tabindex`), reflow without overlap at 320 px, and the generic loading, error and forbidden states through request interception. Negative controls run the same checks on deliberately defective pages and must fail. The result is written to `validation/results/m4-portal-accessibility.json`.

## Seed registry

A route with a URL parameter needs data. Each slice adds one file, `validation/journeys/portal-seeds/<area>.ts`, whose default export is a `SweepSeed`:

- `params`: functions that create data through the stack and return the value for a route parameter (for example `projectId`).
- `routes`: optional per-route overrides.
- `allowUnseeded`: routes the sweep may skip, each with a written reason.
- `skipStateChecks`: routes whose generic loading/error/forbidden checks do not apply, with a reason.

The loader imports every file in the directory and rejects two files claiming the same parameter or route. A parametrised route nobody can seed fails the sweep. `core.ts` seeds `projectId` and a secret; other slices add their own. `login`, `recover` and the 404 page belong to the shell and are covered in a separate test.

## Limitations

- Chromium only (ADR-018). Firefox and WebKit are later milestones.
- ARIA snapshots and axe are the screen-reader-facing oracle. **No human screen-reader session has been run**; that session and the pt-BR/en matrix (VAL-041) are moved to M6.
