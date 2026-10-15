import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const runner = join(skillsDir, "public-suffix/run_vectors.py");
const adapter = join(skillsDir, "public-suffix/adapters/engine.mjs");
const anchor = "  const suffixLength = exceptionLength ? exceptionLength - 1 : matchLength;";
const replacement = "  const suffixLength = 1; // WHI-215 canary: restore last-two-label fallback";
const diagnostic = "FAIL javascript-two-label-canary #22: input='example.uk.com' expected='example.uk.com' actual='uk.com'";
const temporary = mkdtempSync(join(tmpdir(), "amino-psl-engine-canary-"));

function run(engine, name) {
  return spawnSync(
    "python3",
    [runner, "--name", name, "--", "node", adapter, engine],
    { cwd: root, encoding: "utf8" },
  );
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

try {
  const healthy = run(enginePath, "javascript-engine");
  if (healthy.error || healthy.status !== 0 || !healthy.stdout.includes("VECTOR SUMMARY javascript-engine: 78 passed / 0 failed / 78 total")) {
    throw new Error(`healthy official-vector control failed\n${output(healthy)}`);
  }
  const source = readFileSync(enginePath, "utf8");
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`mutation anchor must occur exactly once, got ${count}`);
  const mutated = join(temporary, "engine.mjs");
  writeFileSync(mutated, source.replace(anchor, () => replacement));
  const result = run(mutated, "javascript-two-label-canary");
  if (result.error || result.status === null) {
    throw new Error(`mutated runner did not reach a verdict\n${output(result)}`);
  }
  if (result.status === 0 || !result.stdout.includes(diagnostic)) {
    throw new Error(`fallback mutation did not fail through the named vector\n${output(result)}`);
  }
  console.log("PASS JavaScript PSL fallback mutation canary: 1/1");
  console.log(diagnostic);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
