import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const baselinePath = process.env.BASELINE_ENGINE;
if (!baselinePath) {
  console.error("BASELINE_ENGINE is required");
  process.exit(2);
}

const runner = join(dirname(fileURLToPath(import.meta.url)), "default-adapters.mjs");
const source = readFileSync(enginePath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-default-adapter-canary-"));

function count(sourceText, anchor) {
  let found = 0;
  let offset = 0;
  while ((offset = sourceText.indexOf(anchor, offset)) !== -1) {
    found++;
    offset += anchor.length;
  }
  return found;
}

function run(engine) {
  return spawnSync(process.execPath, [runner], {
    cwd: process.cwd(),
    env: { ...process.env, ENGINE: engine, BASELINE_ENGINE: baselinePath },
    encoding: "utf8",
  });
}

const cases = [
  {
    label: "null-mx-policy-fetch",
    anchor: `  if (isNullMx(await q(domain, "MX"))) {\n    observations.mta_sts_policy = "not_applicable";\n    return;\n  }\n`,
    replacement: "",
    diagnostic: 'B3 null-mx-mta-sts: observations {"mta_sts_policy":"checked","robots":"checked","rdap":"checked"} (exp {"mta_sts_policy":"not_applicable","robots":"checked","rdap":"checked"})',
  },
  {
    label: "rdap-malformed-json-unavailable",
    anchor: "        try { data = await res.json(); } catch (e) { /* response obtained; malformed body */ }",
    replacement: "        try { data = await res.json(); } catch (e) { return null; }",
    diagnostic: 'B3 rdap-invalid-json: observations {"mta_sts_policy":"checked","robots":"checked","rdap":"unavailable"} (exp {"mta_sts_policy":"checked","robots":"checked","rdap":"checked"})',
  },
  {
    label: "mta-sts-wrong-content-type-unavailable",
    anchor: `    if (!(res.contentType || "").toLowerCase().includes("text/plain")) {\n      return { observation: "checked", policy: null };\n    }`,
    replacement: `    if (!(res.contentType || "").toLowerCase().includes("text/plain")) {\n      return { observation: "unavailable", policy: null };\n    }`,
    diagnostic: 'B3 mta-sts-wrong-content-type: observations {"mta_sts_policy":"unavailable","robots":"checked","rdap":"checked"} (exp {"mta_sts_policy":"checked","robots":"checked","rdap":"checked"})',
  },
];

try {
  const healthy = run(enginePath);
  const healthyOutput = `${healthy.stdout || ""}\n${healthy.stderr || ""}`;
  if (healthy.error || healthy.status !== 0 || !healthyOutput.includes("B3 default-adapter observations PASS: 11/11")) {
    throw new Error(`E3 healthy control did not complete all 11 B3 rows\n${healthyOutput}`);
  }
  console.log("E3 healthy PASS: B3 default-adapter observations 11/11.");

  for (const testCase of cases) {
    const occurrences = count(source, testCase.anchor);
    if (occurrences !== 1) {
      throw new Error(`${testCase.label}: engine mutation anchor must occur exactly once, got ${occurrences}`);
    }
    const mutatedPath = join(dir, `${testCase.label}.mjs`);
    writeFileSync(mutatedPath, source.replace(testCase.anchor, () => testCase.replacement));
    const result = run(mutatedPath);
    if (result.error || result.status === null) {
      throw new Error(`${testCase.label}: runner did not reach a verdict: ${result.error || result.signal}`);
    }
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0 || !combined.includes(testCase.diagnostic)) {
      throw new Error(`${testCase.label}: mutation was not rejected by its named B3 row\n${combined}`);
    }
    console.log(`${testCase.label} PASS: mutation red — ${testCase.diagnostic}`);
  }
  console.log(`E3 default-adapter mutation canaries PASS: ${cases.length}/3 named rows.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
