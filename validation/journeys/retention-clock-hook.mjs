// Acceptance process only; product admission never imports this file.
if (process.env.TESTMASTER_ACCEPTANCE_FAULTS !== "1") throw new Error("Acceptance clock disabled");
const original = Date.now;
Date.now = () => original() + 35 * 86400000;
