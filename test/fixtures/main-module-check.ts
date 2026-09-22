// Fixture for isMainModule.test.ts: prints "true"/"false" depending on
// whether *this* module was run directly (as the entry point) or merely
// imported by something else.
import { isMainModule } from "../../src/isMainModule.js";

console.log(isMainModule(import.meta.url));
