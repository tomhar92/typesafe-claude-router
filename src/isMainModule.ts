import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when this module was invoked directly as the process entry point
 * (`node this-file.js`), false when it was merely imported.
 *
 * A plain `import.meta.url === \`file://${process.argv[1]}\`` breaks for
 * any symlinked entry point - notably an npm-installed bin, which is
 * always a symlink into `node_modules/.bin`. Node resolves symlinks when
 * it loads the ESM entry module, so `import.meta.url` reflects the real
 * path while `process.argv[1]` is still the symlink Node was invoked
 * through; the two never match and the "am I main?" check silently does
 * nothing (e.g. the published `typesafe-claude-router-report` bin would
 * never run its `main()`).
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
