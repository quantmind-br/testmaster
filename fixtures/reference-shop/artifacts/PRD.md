# Reference Shop product requirements

Synthetic local-only application; no real customer data. License: Apache-2.0 (original synthetic fixture).

## Authentication
SHOP-AUTH-001: Submitting an empty password shows exactly "Password is required" and creates no authenticated session.
SHOP-AUTH-002: Orders require a bearer token and return HTTP 401 without it.

## Catalog and checkout
SHOP-PRICE-001: All prices are integer cents; three Precision Widgets at 1005 cents each total 3015 cents.
SHOP-SCHEMA-001: Products expose id, name and priceCents.
SHOP-PAGING-001: Offset pagination enumerates every product exactly once.
SHOP-ORDER-001: A successful checkout persists an order that remains visible after a page reload.
SHOP-IDEMPOTENCY-001: Repeating an order Idempotency-Key returns the original order and never duplicates it.
SHOP-EMPTY-001: **Deliberate conflict for adjudication:** empty-cart checkout returns HTTP 400. The OpenAPI declares HTTP 422. Both sources must be retained; neither is silently authoritative until reviewer approval.

## Other flows
SHOP-HEALTH-001: GET /health returns HTTP 200 with status "ok".
SHOP-HOOK-001: Checkout exposes data-testid="checkout-button". Renaming the hook is nonfunctional drift, not a business regression.
Profile files are uploaded as raw bytes and downloaded without changes. Terms open in a popup. A same-origin delivery iframe supports Standard and Express.
Catalog readiness is explicit via data-testid="catalog-ready" after asynchronous loading; navigation is SPA with browser history.

## Review
The intentional status conflict requires two independent reviewers, source locations and a recorded adjudication before benchmark classification. Labels in the evaluation manifest are not model input. No production execution or personal data is allowed.

## Reproduction and evidence
Run `node fixtures/reference-shop/src/server.js --port 3000` (set `REFERENCE_SHOP_MUTANT` for a negative control), or call `startShop({port: 0, mutant})`. Each instance owns its SQLite file and cleanup. Oracle checks use raw HTTP plus a separate read-only SQLite connection; browser checks additionally reload orders rather than trusting the success toast.

Regenerate deterministic documents/digest with `node fixtures/reference-shop/artifacts/generate.js`, archives with `node fixtures/adversarial/generate.js`, then format the corpus with Biome. Unit controls run with `pnpm exec vitest run --project unit fixtures`; real Chromium controls use `pnpm exec vitest run --project docker fixtures/reference-shop`.

The browser harness publishes only Playwright's server on host loopback, runs non-root in the pinned image, and binds the shop to the Docker gateway. Because this workstation's firewall rejects bridge-to-host ingress, the harness exposes only the gateway address via Playwright's WebSocket network tunnel; it does not modify firewall rules. This test-only connectivity does not validate the product sandbox's egress policy. Independent human labeling is explicitly pending in the corpus manifest; no release or model-quality claim follows from these controls.

Chromium is explicitly launched with `chromiumSandbox: true`; the remote server's default (sandbox disabled) is not used. The test reads `containers/seccomp_profile.json`, keeps `--cap-drop ALL` and `no-new-privileges`, and never falls back on sandbox failure. `run-server --unsafe` only permits the trusted loopback test client to request sandbox enablement; it does not alter application execution policy.
