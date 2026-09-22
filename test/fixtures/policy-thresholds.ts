// Fixture for policy.test.ts: prints the module-level MARGIN_THRESHOLD/
// STICKY_ASSUMPTION constants as JSON. These are read from
// ROUTER_MARGIN_THRESHOLD/ROUTER_STICKY_ASSUMPTION once, at module load
// time, so proving they pick up an env var override needs a fresh process
// - re-importing the already-loaded module in this test file's own
// process wouldn't re-run that top-level read.
import { MARGIN_THRESHOLD, STICKY_ASSUMPTION } from "../../src/policy.js";

console.log(JSON.stringify({ MARGIN_THRESHOLD, STICKY_ASSUMPTION }));
