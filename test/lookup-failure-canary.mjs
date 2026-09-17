import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const source = readFileSync(enginePath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-lookup-canary-"));

function replaceOnce(anchor, replacement, label) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  return source.replace(anchor, () => replacement);
}

function run(engine) {
  return spawnSync(process.execPath, ["test/lookup-failure.mjs"], {
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
    throw new Error(`${label}: mutation did not fail through the named S4 row\n${output}`);
  }
  console.log(`${label} PASS: ${diagnostic}`);
}

try {
  const healthy = run(enginePath);
  const healthyOutput = `${healthy.stdout || ""}\n${healthy.stderr || ""}`;
  if (healthy.status !== 0 || !healthyOutput.includes("S4 default-adapter lookup outcomes PASS: 10/10")) {
    throw new Error(`S5 lookup healthy control failed\n${healthyOutput}`);
  }
  console.log("S5 lookup healthy control PASS: S4 10/10.");

  prove(
    "failure-treated-as-absence",
    replaceOnce("  if (lookup.failed) {", "  if (false && lookup.failed) {", "failure-treated-as-absence"),
    'S4 status-2: expected title "Unable to confirm MTA-STS policy", got "No MTA-STS policy"',
  );
  prove(
    "nxdomain-treated-as-failure",
    replaceOnce("![0, 3].includes(meta?.status)", "![0].includes(meta?.status)", "nxdomain-treated-as-failure"),
    'S4 status-3: expected title "No MTA-STS policy", got "Unable to confirm MTA-STS policy"',
  );
  prove(
    "formerr-treated-as-authoritative",
    replaceOnce("![0, 3].includes(meta?.status)", "![0, 1, 3].includes(meta?.status)", "formerr-treated-as-authoritative"),
    'S4 status-1: expected title "Unable to confirm MTA-STS policy", got "No MTA-STS policy"',
  );
  prove(
    "policy-fetched-on-lookup-failure",
    replaceOnce(
      "  if (lookup.failed) {\n    observations.mta_sts_policy = \"unavailable\";",
      "  if (lookup.failed) {\n    await fetchMtaStsPolicy(domain, q, http, dns);\n    observations.mta_sts_policy = \"unavailable\";",
      "policy-fetched-on-lookup-failure",
    ),
    "S4 status-2: expected 0 policy fetches, got 1",
  );
  prove(
    "mta-sts-drives-inconclusive",
    replaceOnce(
      'for (const [n, t] of [[domain, "TXT"], ["_dmarc." + domain, "TXT"], [domain, "MX"]])',
      'for (const [n, t] of [[domain, "TXT"], ["_dmarc." + domain, "TXT"], [domain, "MX"], ["_mta-sts." + domain, "TXT"]])',
      "mta-sts-drives-inconclusive",
    ),
    "S4 status-2: expected inconclusive false, got true",
  );
  console.log("S5 lookup-failure canaries PASS: 5/5 named rows.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
