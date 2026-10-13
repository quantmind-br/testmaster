# ADR-018: Portal stack

- Status: accepted
- Date: 2026-10-13
- Scope: the M4 web portal (`apps/web`) and its serving by `apps/server`.

## Context

M4 requires a self-hosted portal with setup, review, edit, run, live view, history, artifacts, settings and admin (REQ-036, M4-04, M4-05), accessible (NFR-008, J16, UX-051–056), using only public catalog routes.

## Decision

- **Package.** New workspace package `apps/web` (`@testmaster/web`), outside the root `tsc -b` graph.
  - Dependencies: `react@19.3.0`, `react-dom@19.3.0`, `react-router@8.4.0` (data router, `createBrowserRouter`).
  - Dev dependencies: `vite@8.3.4`, `@vitejs/plugin-react@6.1.2`, `@types/react`, `@types/react-dom` (latest versions compatible with React 19.3 at install time; pin exact).
  - Its `build` script is `tsc --noEmit -p tsconfig.json && vite build`.
  - The root `build` becomes `tsc -b && pnpm --filter @testmaster/web build && chmod +x apps/cli/dist/main.js`.
- **Serving.** `apps/server` serves `apps/web/dist` same-origin. No `@fastify/static`; use a small confined file server:
  - `/assets/*`: immutable cache, `ETag` sha256.
  - Every other non-`/v1`, non-`/mcp` GET returns `index.html` with `Cache-Control: no-store`.
  - Headers on portal responses:
    - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
    - `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`
- **UI behavior.**
  - English UI text only. The pt-BR/en matrix is VAL-041, registry M5.
  - No CSS framework, no state library, no chart library. CSS custom properties define light and dark themes (`prefers-color-scheme`). All text tokens have contrast ≥ 4.5:1; focus rings and components have ≥ 3:1.
  - Status always renders text plus an icon shape.
  - Untrusted content (titles, PRD, Markdown, logs, DOM) renders as escaped text. HTML/trace artifacts only open via signed gateway links inside `<iframe sandbox="">` or as downloads.
- **Browser scope.** Chromium only (Playwright 1.63 `chromium-1234` already installed). Firefox/WebKit are REQ-045/M5-03.
- **Accessibility evidence.**
  - `axe-core@4.14.0` (devDependency of `@testmaster/validation`) is injected into journey pages, requiring zero serious/critical violations.
  - Keyboard-only Playwright journeys.
  - ARIA snapshot (`locator.ariaSnapshot()`) assertions as the screen-reader-facing oracle.
  - No human screen-reader session is claimed. Record it as a limitation in J16's `note` and in `docs/support-matrix.md`.

## Consequences

- Chromium-only portal claim; no human screen-reader session; English-only UI in M4.
- The portal has no private endpoints: a network-log check in the authoring and accessibility journeys enforces catalog `/v1` routes only.
