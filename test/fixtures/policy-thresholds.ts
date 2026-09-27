// Fixture for policy.test.ts: prints the module-level MARGIN_THRESHOLD/
// STICKY_ASSUMPTION constants and DEFAULT_LIMITS as JSON. These are read from
// env vars once, at module load time, so proving they pick up overrides needs a fresh process
// - re-importing the already-loaded module in this test file's own
// process wouldn't re-run that top-level read.
import { MARGIN_THRESHOLD, STICKY_ASSUMPTION, DEFAULT_LIMITS } from "../../src/policy.js";

console.log(JSON.stringify({ MARGIN_THRESHOLD, STICKY_ASSUMPTION, DEFAULT_LIMITS }));
