import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const source = readFileSync(enginePath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-contract-17-canary-"));
let passed = 0;

function replaceOnce(input, anchor, replacement, label) {
  const count = input.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  return input.replace(anchor, () => replacement);
}

function runContract(engine) {
  return spawnSync(process.execPath, ["test/contract-17.mjs"], {
    cwd: process.cwd(), env: { ...process.env, ENGINE: engine }, encoding: "utf8",
  });
}

function runCorpus(engine) {
  return spawnSync(process.execPath, [join(skillsDir, "conformance/run.mjs")], {
    cwd: process.cwd(), env: { ...process.env, ENGINE: engine, SURFACE: "web" }, encoding: "utf8",
  });
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function expectRed(name, mutated, runner, diagnostics) {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, mutated);
  const result = runner(path);
  const combined = output(result);
  const matches = diagnostics.every((diagnostic) => combined.includes(diagnostic));
  if (result.error || result.status === null) throw new Error(`${name}: runner did not reach a verdict\n${combined}`);
  if (result.status === 0 || !matches) {
    throw new Error(`${name}: expected non-zero with ${JSON.stringify(diagnostics)}\n${combined}`);
  }
  passed += 1;
  console.log(`PASS C17 canary ${name}: ${diagnostics.join(" | ")}`);
}

try {
  const healthy = runContract(enginePath);
  if (healthy.status !== 0 || !output(healthy).includes("C17 contract 1.7 harness: 12 passed, 0 failed")) {
    throw new Error(`C17 healthy control failed\n${output(healthy)}`);
  }
  console.log("PASS C17 canary healthy control: 10 cases / 12 checks.");

  expectRed(
    "unbounded-long-name-walk",
    replaceOnce(source, "  const startIndex = Math.max(1, labels.length - 7);", "  const startIndex = 1;", "walk bound"),
    runContract,
    ["FAIL C17 E9b unqualified intermediate does not stop psd-y"],
  );
  expectRed(
    "tld-omitted",
    replaceOnce(source, "  for (let i = startIndex; i < labels.length; i++) {", "  for (let i = startIndex; i < labels.length - 1; i++) {", "TLD inclusion"),
    runContract,
    ["FAIL C17 E11 walk includes TLD for existing name", "FAIL C17 E11b walk includes TLD for NXDOMAIN"],
  );
  expectRed(
    "psd-opt-in-ignored",
    replaceOnce(source, '    if (psd === "y") {', '    if (psd === "never") {', "PSD opt-in"),
    runContract,
    ["FAIL C17 E1 psd-y strong sp is capped non-pass"],
  );
  expectRed(
    "organizational-record-ignored",
    replaceOnce(source, "      const organizationalRecord = recordsAboveRoot.get(organizational);", "      const organizationalRecord = null;", "organizational record"),
    runContract,
    ["FAIL C17 E9 organizational record below psd-y wins"],
  );
  expectRed(
    "nxdomain-treated-as-existing",
    replaceOnce(source, "  if (metadata?.status === 3) return false;", "  if (metadata?.status === 3) return true;", "NXDOMAIN existence"),
    runContract,
    ["FAIL C17 E3 NXDOMAIN selects np"],
  );
  expectRed(
    "lookup-failure-treated-as-nxdomain",
    replaceOnce(source, "  if (metadata?.status === 0) return true;", "  if (metadata?.status === 0) return true;\n  if (metadata?.status === 2) return false;", "failed existence"),
    runContract,
    ["FAIL C17 E10 failed existence chooses weaker outcome"],
  );
  expectRed(
    "strong-platform-policy-passes",
    replaceOnce(source, 'F.push({ area: "DMARC", severity: strong ? "low" : "high", title,', 'F.push({ area: "DMARC", severity: strong ? "pass" : "high", title,', "non-pass cap"),
    runContract,
    ["FAIL C17 E1 psd-y strong sp is capped non-pass"],
  );
  expectRed(
    "psd-score-not-credited",
    replaceOnce(
      source,
      '  if (dmarc && (dmarcContext.relationship === "self" || dmarcContext.relationship === "psd")) {',
      '  if (dmarc && dmarcContext.relationship === "self") {',
      "PSD score credit",
    ),
    runContract,
    ["FAIL C17 E1 psd-y strong sp is capped non-pass score"],
  );
  expectRed(
    "parent-observation-suppresses-absence",
    replaceOnce(
      source,
      '  if (disc.relationship === "parent_observation") {\n    appendNoDmarc(F);',
      '  if (disc.relationship === "parent_observation") {',
      "parent absence retention",
    ),
    runCorpus,
    ["registrable-root-nhs-uk", "No DMARC record"],
  );
  expectRed(
    "platform-action-not-distinct",
    replaceOnce(
      source,
      '    if (t.includes("platform policy") || t.includes("parent dmarc record observed")) return "Publish your own DMARC policy for control";\n',
      "",
      "distinct DMARC action",
    ),
    runCorpus,
    ["dmarc-parent-psd-y-sp-reject", "Publish your own DMARC policy for control"],
  );

  if (passed !== 10) throw new Error(`C17 canary pass floor: expected 10, got ${passed}`);
  console.log("C17 contract 1.7 mutation canaries PASS: 10/10 named gates.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
