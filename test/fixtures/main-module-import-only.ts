// Fixture for isMainModule.test.ts: runs main-module-check.ts as an
// imported dependency rather than as the entry point, so its
// isMainModule(import.meta.url) call should print "false".
import "./main-module-check.js";
