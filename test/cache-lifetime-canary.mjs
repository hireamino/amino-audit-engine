import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testPath = "test/default-adapters.mjs";
const source = readFileSync(testPath, "utf8");
const anchor = 'const perRequestExpectedTitle = "SPF present";';
const replacement = 'const perRequestExpectedTitle = "No SPF record";';
const occurrences = source.split(anchor).length - 1;
if (occurrences !== 1) throw new Error(`B1 per-request assertion anchor must occur exactly once, got ${occurrences}`);

const dir = mkdtempSync(join(tmpdir(), "amino-engine-cache-canary-"));
const mutated = join(dir, "default-adapters.mjs");
try {
  writeFileSync(mutated, source.replace(anchor, replacement));
  const result = spawnSync(process.execPath, [mutated], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  const diagnostic = 'B1 per-request audit 2 expected "No SPF record" and no "No SPF record"';
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !combined.includes(diagnostic)) {
    throw new Error(`B1 inverted per-request assertion did not fail as required\n${combined}`);
  }
  console.log(`B1 assertion canary PASS: ${diagnostic}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
