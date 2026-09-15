import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const runner = process.env.RUNNER || `${process.env.SKILLS_DIR}/conformance/run.mjs`;
if (!process.env.SKILLS_DIR && !process.env.RUNNER) {
  console.error("SKILLS_DIR or RUNNER is required");
  process.exit(2);
}
const source = readFileSync(enginePath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-observation-canary-"));

function count(sourceText, anchor) {
  let found = 0;
  let offset = 0;
  while ((offset = sourceText.indexOf(anchor, offset)) !== -1) {
    found++;
    offset += anchor.length;
  }
  return found;
}

function run(engine, fixture) {
  return spawnSync(process.execPath, [runner], {
    cwd: process.cwd(),
    env: { ...process.env, SURFACE: "action", ENGINE: engine, CONFORMANCE_FIXTURE: fixture },
    encoding: "utf8",
  });
}

const cases = [
  {
    label: "mta-sts-policy-wrong-state",
    fixture: "mta-sts-policy-unavailable",
    anchor: "observations.mta_sts_policy = observation;",
    replacement: 'observations.mta_sts_policy = "checked";',
    diagnostic: 'observations: expected {"mta_sts_policy":"unavailable","robots":"checked","rdap":"checked"}, got {"mta_sts_policy":"checked","robots":"checked","rdap":"checked"}',
  },
  {
    label: "robots-wrong-state",
    fixture: "robots-unavailable",
    anchor: "observations.robots = observation;",
    replacement: 'observations.robots = "checked";',
    diagnostic: 'observations: expected {"mta_sts_policy":"not_applicable","robots":"unavailable","rdap":"checked"}, got {"mta_sts_policy":"not_applicable","robots":"checked","rdap":"checked"}',
  },
  {
    label: "rdap-wrong-state",
    fixture: "rdap-unavailable",
    anchor: "observations.rdap = observation;",
    replacement: 'observations.rdap = "checked";',
    diagnostic: 'observations: expected {"mta_sts_policy":"not_applicable","robots":"checked","rdap":"unavailable"}, got {"mta_sts_policy":"not_applicable","robots":"checked","rdap":"checked"}',
  },
];

try {
  for (const testCase of cases) {
    const healthy = run(enginePath, testCase.fixture);
    if (healthy.status !== 0) {
      throw new Error(`${testCase.label}: healthy control failed\n${healthy.stdout || ""}\n${healthy.stderr || ""}`);
    }
    const occurrences = count(source, testCase.anchor);
    if (occurrences !== 1) {
      throw new Error(`${testCase.label}: engine mutation anchor must occur exactly once, got ${occurrences}`);
    }
    const mutated = join(dir, `${testCase.label}.mjs`);
    writeFileSync(mutated, source.replace(testCase.anchor, () => testCase.replacement));
    const result = run(mutated, testCase.fixture);
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0 || !combined.includes(testCase.diagnostic)) {
      throw new Error(`${testCase.label}: comparison did not reject the wrong state with the required diagnostic\n${combined}`);
    }
    console.log(`${testCase.label} PASS: healthy green; mutation red — ${testCase.diagnostic}`);
  }
  console.log(`Observation mutation canaries PASS: ${cases.length}/3 ports, through result comparison.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
