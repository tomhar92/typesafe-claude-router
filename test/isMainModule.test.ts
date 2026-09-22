import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/main-module-check.ts", import.meta.url));
const importOnlyFixture = fileURLToPath(
  new URL("./fixtures/main-module-import-only.ts", import.meta.url)
);

function runNode(path: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", path], { encoding: "utf8" }).trim();
}

test("reports true when run directly as the entry point", () => {
  assert.equal(runNode(fixture), "true");
});

test("reports false when merely imported by another module", () => {
  assert.equal(runNode(importOnlyFixture), "false");
});

test("reports true when invoked through a symlink - the exact shape of an npm-installed bin", () => {
  // This is the regression case: `import.meta.url === \`file://${argv[1]}\``
  // fails here because Node resolves the symlink when loading the ESM
  // entry module (so import.meta.url is the real path) while argv[1] is
  // still the symlink path the process was actually invoked through.
  const dir = mkdtempSync(join(tmpdir(), "main-module-symlink-"));
  const linkPath = join(dir, "linked-entry.ts");
  symlinkSync(realpathSync(fixture), linkPath);
  assert.equal(runNode(linkPath), "true");
});
