import type { SweepSeed } from "./types.js";

/**
 * The GitHub App detail page only renders for an App that went through the manifest flow, which
 * needs the fake GitHub behind a public webhook origin. `github-portal.portal.test.ts` exercises
 * that page against the fake with the same checks the sweep applies (axe on desktop and at 320 px
 * and 200% zoom, the keyboard, the problem states), so the sweep lists it instead of faking an App row.
 */
const seed: SweepSeed = {
  allowUnseeded: {
    "/integrations/github/:integrationId":
      "Needs a GitHub App installed through the manifest flow; covered at desktop, 320 px, 200% zoom and by keyboard in validation/journeys/github-portal.portal.test.ts.",
  },
};

export default seed;
