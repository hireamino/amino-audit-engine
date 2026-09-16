import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const runner = process.env.RUNNER || `${process.env.SKILLS_DIR}/conformance/run.mjs`;
if (!process.env.SKILLS_DIR && !process.env.RUNNER) {
  console.error("SKILLS_DIR or RUNNER is required");
  process.exit(2);
}

const observer = join(dirname(fileURLToPath(import.meta.url)), "network-observe.mjs");
const source = readFileSync(enginePath, "utf8");
const anchor = "http: q.http || UNAVAILABLE_HTTP,";
const replacement = "http: createDefaultAdapters().http,";
const occurrences = source.split(anchor).length - 1;
if (occurrences !== 1) {
  throw new Error(`E1 compatibility HTTP mutation anchor must occur exactly once, got ${occurrences}`);
}

function run(engine) {
  return spawnSync(process.execPath, [observer], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUNNER: runner,
      ENGINE: engine,
      SURFACE: "action",
      EXPECT_FETCH_CALLS: "0",
    },
    encoding: "utf8",
  });
}

function observation(result, label) {
  if (result.error || result.status === null) {
    throw new Error(`${label}: observer did not reach a verdict: ${result.error || result.signal}`);
  }
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = combined.match(/Network observation: (\d+) fetch attempts, (\d+) distinct URLs\./);
  if (!match) throw new Error(`${label}: observer did not print a fetch count\n${combined}`);
  return { combined, fetches: Number(match[1]), distinct: Number(match[2]) };
}

const dir = mkdtempSync(join(tmpdir(), "amino-engine-network-positive-"));
try {
  const healthyResult = run(enginePath);
  const healthy = observation(healthyResult, "E1 healthy control");
  if (healthyResult.status !== 0 || healthy.fetches !== 0) {
    throw new Error(`E1 healthy control expected exit 0 and 0 fetches, got exit ${healthyResult.status} and ${healthy.fetches}`);
  }
  console.log(`E1 healthy PASS: Network observation: ${healthy.fetches} fetch attempts, ${healthy.distinct} distinct URLs.`);

  const mutatedPath = join(dir, "compatibility-http-bypass.mjs");
  writeFileSync(mutatedPath, source.replace(anchor, () => replacement));
  const mutatedResult = run(mutatedPath);
  const mutated = observation(mutatedResult, "E1 compatibility HTTP bypass");
  if (mutatedResult.status === 0 || mutated.fetches <= 0) {
    throw new Error(`E1 compatibility HTTP bypass expected non-zero exit and N > 0 fetches, got exit ${mutatedResult.status} and ${mutated.fetches}`);
  }
  console.log(`E1 compatibility HTTP bypass PASS: Network observation: ${mutated.fetches} fetch attempts, ${mutated.distinct} distinct URLs; observer exited ${mutatedResult.status}.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
