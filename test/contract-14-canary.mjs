import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const source = readFileSync(enginePath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-contract-14-canary-"));

function replaceOnce(sourceText, anchor, replacement, label) {
  const count = sourceText.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  return sourceText.replace(anchor, () => replacement);
}

function run(engine) {
  return spawnSync(process.execPath, ["test/contract-14.mjs"], {
    cwd: process.cwd(), env: { ...process.env, ENGINE: engine }, encoding: "utf8",
  });
}

function prove(label, mutatedSource, diagnostic) {
  const file = join(dir, `${label}.mjs`);
  writeFileSync(file, mutatedSource);
  const result = run(file);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error || result.status === null) throw new Error(`${label}: runner did not reach a verdict`);
  if (result.status === 0 || !output.includes(diagnostic)) {
    throw new Error(`${label}: mutation did not fail through the named C14 row\n${output}`);
  }
  console.log(`${label} PASS: ${diagnostic}`);
}

try {
  const healthy = run(enginePath);
  const healthyOutput = `${healthy.stdout || ""}\n${healthy.stderr || ""}`;
  if (healthy.status !== 0 || !healthyOutput.includes("C14 contract 1.4 rows PASS: 8/8")) {
    throw new Error(`C14 healthy control failed\n${healthyOutput}`);
  }
  console.log("C14 canary healthy control PASS: 8/8.");

  prove(
    "no-address-reported-unavailable",
    replaceOnce(source, ': addressState === "no_answers" ? "not_applicable" : "unavailable";', ': "unavailable";', "no-address-reported-unavailable"),
    "C14 authoritative-no-address: expected robots not_applicable, got unavailable",
  );
  prove(
    "failed-lookup-reported-not-applicable",
    replaceOnce(source, '? "lookup_failed" : "no_answers";', '? "no_answers" : "no_answers";', "failed-lookup-reported-not-applicable"),
    "C14 address-lookup-failed: expected robots unavailable, got not_applicable",
  );
  prove(
    "refused-address-reported-not-applicable",
    replaceOnce(source, ': addressState === "no_answers" ? "not_applicable" : "unavailable";', ': ["no_answers", "refused"].includes(addressState) ? "not_applicable" : "unavailable";', "refused-address-reported-not-applicable"),
    "C14 address-refused: expected robots unavailable, got not_applicable",
  );
  prove(
    "mta-sts-no-address-reported-not-applicable",
    replaceOnce(
      source,
      '    if ((await publicAddressState("mta-sts." + domain, null, q)) !== "public") {\n      return { observation: "unavailable", policy: null };\n    }',
      '    if ((await publicAddressState("mta-sts." + domain, null, q)) !== "public") {\n      return { observation: "not_applicable", policy: null };\n    }',
      "mta-sts-no-address-reported-not-applicable",
    ),
    "C14 mta-sts-policy-host-no-address: expected mta_sts_policy unavailable, got not_applicable",
  );
  prove(
    "rdap-bare-object-restored",
    replaceOnce(source, "  const data = response.data;", '  const data = Object.prototype.hasOwnProperty.call(response, "data")\n    ? response.data : response;', "rdap-bare-object-restored"),
    'C14 rdap-bare-object-rejected: expected no Reputation finding, got "Domain is newly registered (10 days)"',
  );
  console.log("C14 contract mutation canaries PASS: 5/5 named rows.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
