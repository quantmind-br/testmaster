# ADR-032: Browser matrix cells, visual baselines and accessibility assertions

- Status: accepted
- Date: 2026-10-22
- Scope: ROADMAP M5-03 (browser matrix and visual regression: REQ-045, REQ-046, VAL-040) and M5-04 (accessibility assertions: REQ-047, VAL-041).

## Context

Until M5, every Playwright Run used Chromium at the configured viewport. `config.browser` named the engine and viewport, but admission refused any engine other than Chromium, and `visualMatches`, `accessibilityViolations` and the visual-baseline routes answered `CAPABILITY_UNAVAILABLE`. REQ-045 requires cells of engine, viewport, colour scheme and reduced motion; REQ-046 requires visual regression against a baseline approved per cell, with diff, threshold and masks, where a Run never updates a baseline to make itself green. `specs/10-validation.md` notes that a visual baseline is specific to engine, platform, fonts and viewport. REQ-047 requires axe-core scans and keyboard checks with WCAG tags and evidence, and forbids presenting them as full conformance; VAL-041 requires criteria that cannot be automated to be reported as not verified.

## Decision

### Matrix cells

- A cell is `{browser?, viewport?, colorScheme?, reducedMotion?}` (`MatrixCell`). `RunRequest.cell` asks for one; `SelectionInput.matrix` (`browsers`, `viewports`, `colorSchemes`) expands into their cartesian product, browsers outermost, and the CLI's repeatable `--browser`, `--viewport` and `--color-scheme` flags build the same axes. A selection whose tests × cells exceed `defaults.batchCells` is refused with `INVALID_ARGUMENT` and `matrix_too_large` before any Run exists: the limit bounds one batch's rows and queue entries, which would otherwise grow without bound from a short command line.
- The cell is frozen into the Run's effective configuration (`config.browser`), not into a separate field. `logicalRunKey`, the flake identity and reruns already hash or copy `config.browser`, so two cells never share a comparison cohort or flake history, and a rerun reproduces its cell. A leaf takes the origin `flag` only when the requested value differs from the configured one, so a request that repeats the configuration keeps the configuration's provenance.
- The runtime identity is measured once per pinned image for all three engines in one sandboxed container. A Run's identity names the engine and version of its own cell.
- Firefox and WebKit launch in the same hardened container as Chromium (B-06), behind the same egress proxy, which routes loopback targets with `bypass: "<-loopback>"` inside `--network none`. Chromium keeps its own sandbox. Firefox and WebKit have no sandbox switch to keep, and Playwright's WPE WebKit build has no bubblewrap sandbox, so the container bounds them. `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS` is never set, and no hardening flag changed.

### Visual baselines

- `visualMatches` names a baseline (`baseline`), optional masks (1 to 10 locators) and an optional `threshold` (a fraction of pixels, default 0). A mask equal to a locator that another assertion of the plan checks is refused at validation (`mask_hides_assertion`): a mask must never hide what the test asserts.
- The digest of a cell (`visualMatrixDigest`) hashes engine, viewport, locale, timezone, colour scheme, reduced motion, the platform and the pinned runner image id. It does not contain the measured engine version: the server profile admits Runs without Docker and so without a measured identity, and the pinned image id already fixes the engine build. A Run admitted by the process executor has no image and no digest, so no baseline applies to it.
- Baselines are resolved at admission, not when the Attempt is prepared. For each `visualMatches` step, admission records `available` (with the baseline id and sha256), `missing` or `stale` in `matrixCell.visualBaselines`, and the admission input hash covers it. A replay or rerun therefore compares against the same image even after a newer approval, and server and remote-worker admission behave alike. The Attempt stages the approved bytes into the input mount only after they hash to the frozen sha256.
- A baseline approved for other masks is `stale`; comparing it would hide or expose regions its reviewer never saw. A missing or stale baseline ends the Run `blocked` (`visual_baseline_missing`, `visual_baseline_stale`) with the captured image kept as `visual/<step>-candidate.png`. An image the in-house decoder does not support ends it `blocked` with `visual_baseline_unsupported`.
- A baseline is created as a `draft` from a completed Run's candidate or actual image, never from restricted raw evidence. Approval is a named reviewer decision (`authorizeNamed("approve", "VisualBaseline")`, the `tests:approve` grant on a bearer token, per ADR-017), and the approver must not be the creator (`self_approval`). Approving supersedes the earlier approved baseline of the same test, name and digest; superseded rows stay listed. No Run creates, approves or replaces a baseline.
- Baseline bytes are copied content-addressed into the data directory (`visual-baselines/<workspace>/<project>/<sha256>`), not referenced from the source Run's bundle, so retention that deletes the Run's evidence cannot delete an approved baseline.
- The runner captures the element, paints masks, text inputs, `[data-sensitive]` and password fields, and secret text in `#FF00FF`, and paints the masks' current rectangles on both images before comparing, so a moved masked element cannot leak a difference. The comparison is in-house: a PNG decoder and encoder (all five filters, CRC-checked, 8-bit RGB and RGBA) and a pixelmatch-style YIQ delta with pixelmatch's default tolerance. It adds no image dependency to the runner image.
- A Run whose plan has a `visualMatches` step reads one fixed time (`2026-01-01T00:00:00.000Z`, Playwright `clock.setFixedTime`): a page that renders the current time looks the same in the baseline Run and every later one, while its timers keep running. Plans without an image comparison keep the real clock. The capture disables CSS animations and hides the caret, and fonts are those of the pinned runner image, so clock, fonts and animations are stable inputs of a comparison (VAL-041).

### Accessibility assertions

- `accessibilityViolations` scans the step's locator with axe-core 4.14.0 and passes when the serious and critical violating elements are at most `maximum`. `tags` selects axe rule tags; without it the scan uses WCAG 2.0, 2.1 and 2.2 A/AA plus `best-practice`, the same set the portal's own accessibility journeys use. The step's locator is the scan's scope, so the plan contract gains no separate scope field. Minor and moderate violations and the rules needing review are reported, not counted.
- axe-core ships inside the runner image (`packages/runner` dependency, runner import allowlist, image copy list). The runner reads `axe.min.js` from its own `node_modules` and evaluates it in the element's frame through the browser protocol instead of adding a script element, so the scan fetches nothing. A scan that cannot run ends the step `inconclusive` (`oracle_uncertain`), never passed.
- Every scan writes `a11y/<step>.json`: engine and version, tags, the counted total, violations and rules needing review (element HTML cut at 500 characters, through the evidence redaction), the WCAG 2.2 A/AA success criteria some rule judged, the criteria no rule judged (`notVerified`) and the limitation `automated_scan_only`. The step's observed value carries the counts and the limitation, and the Markdown and HTML reports print one line per scan saying it is an automated scan that does not establish WCAG conformance and how many criteria it left unverified. No surface calls a scan a certification.
- Keyboard workflows are ordinary `press` steps: pressing a key on `:focus` follows the page's real focus order, so a plan can prove that Tab reaches a control and Space activates it.

## Consequences

- Each engine needs its own approved baseline: a cell change (engine, viewport, scheme, motion, image) finds no baseline until a reviewer approves one.
- With one local principal, the creator cannot approve their own draft; a second person approves through a server. This is deliberate: an approval by the person who captured the image is not a review.
- A runner image rebuild changes every digest, so baselines must be re-approved after an image change. The release notes of an image change say so.
- Firefox and WebKit rely on the container for isolation. The threat model lists this as boundary B-31.
- A scan without findings is evidence about the rules it ran, not a conformance statement; criteria that need a person (captions, meaningful sequence, error suggestions and others) stay listed as not verified on every report.
