import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const runner = resolve(skillsDir, "conformance/run.mjs");
const contract = resolve("test/contract-18.mjs");
const source = readFileSync(enginePath, "utf8");
const temporary = mkdtempSync(join(tmpdir(), "amino-contract-18-canary-"));
let passed = 0;

function replaceOnce(input, anchor, replacement, label) {
  const count = input.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  return input.replace(anchor, () => replacement);
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function runContract(engine) {
  return spawnSync(process.execPath, [contract], {
    cwd: root,
    env: { ...process.env, ENGINE: engine },
    encoding: "utf8",
  });
}

function runFixture(engine, fixture, surface) {
  return spawnSync(process.execPath, [runner], {
    cwd: root,
    env: { ...process.env, ENGINE: engine, CONFORMANCE_FIXTURE: fixture, SURFACE: surface },
    encoding: "utf8",
  });
}

function requireGreen(result, label) {
  if (result.error || result.status !== 0) throw new Error(`${label}: healthy control failed\n${output(result)}`);
}

function requireRed(result, diagnostic, label) {
  const combined = output(result);
  if (result.error || result.status === null) throw new Error(`${label}: runner did not reach a verdict\n${combined}`);
  if (result.status === 0 || !combined.includes(diagnostic)) {
    throw new Error(`${label}: mutation did not fail through ${JSON.stringify(diagnostic)}\n${combined}`);
  }
  passed += 1;
  console.log(`${label} PASS: ${diagnostic}`);
}

try {
  requireGreen(runContract(enginePath), "normalization healthy control");
  for (const fixture of ["mx-provider-psl-distinct", "dmarc-external-null-organizations"]) {
    for (const surface of ["web", "action"]) requireGreen(runFixture(enginePath, fixture, surface), `${fixture}/${surface}`);
  }
  console.log("WHI-254 healthy controls PASS: normalization and both changed outcomes on web and Action.");

  const providerAnchor = "      const provider = registrableDomain(host) || host;";
  const providerMutation = "      const labels = host.split(\".\");\n      const provider = labels.length >= 2 ? labels.slice(-2).join(\".\") : host;";
  const providerEngine = join(temporary, "provider.mjs");
  writeFileSync(providerEngine, replaceOnce(source, providerAnchor, providerMutation, "provider fallback"));
  requireRed(
    runFixture(providerEngine, "mx-provider-psl-distinct", "web"),
    "mx-provider-psl-distinct.findings[MX|Mixed MX providers (2)].identity: expected finding, got missing",
    "WHI-254 last-two-label provider canary",
  );

  const sameOrgAnchor = "      const sameOrg = domainOrg !== null && destOrg !== null && domainOrg === destOrg;";
  const sameOrgEngine = join(temporary, "same-org.mjs");
  writeFileSync(
    sameOrgEngine,
    replaceOnce(source, sameOrgAnchor, "      const sameOrg = domainOrg === destOrg;", "null-equals-null"),
  );
  requireRed(
    runFixture(sameOrgEngine, "dmarc-external-null-organizations", "action"),
    "dmarc-external-null-organizations.findings[DMARC|DMARC report destination not authorized].identity: expected finding, got missing",
    "WHI-254 null-equals-null canary",
  );

  const normalizationAnchor = `  const labels = [];
  for (const label of display) {
    try {
      // Convert one DNS label at a time. Whole-host URL parsing rewrites IPv4
      // numeric shortcuts such as 0x7f.1, which is outside the DNS-name contract.
      const suffix = ".invalid";
      const encodedHost = new URL(\`http://\${label}\${suffix}\`).hostname.toLowerCase();
      if (!encodedHost.endsWith(suffix)) return null;
      const encoded = encodedHost.slice(0, -suffix.length);
      if (!encoded || encoded.includes(".") || encoded.length > 63) return null;
      labels.push(encoded);
    } catch {
      return null;
    }
  }`;
  const normalizationMutation = `  let ascii;
  try {
    ascii = new URL(\`http://\${normalized}\`).hostname.replace(/\\.+$/, "").toLowerCase();
  } catch {
    return null;
  }
  const labels = ascii.split(".");
  if (labels.length !== display.length || labels.some((label) => !label)) return null;`;
  const normalizationEngine = join(temporary, "normalization.mjs");
  writeFileSync(
    normalizationEngine,
    replaceOnce(source, normalizationAnchor, normalizationMutation, "whole-host URL normalization"),
  );
  const normalizationResult = runContract(normalizationEngine);
  requireRed(normalizationResult, "FAIL WHI-254 64-octet label is rejected", "WHI-254 overlong-label canary");
  const normalizationOutput = output(normalizationResult);
  if (!normalizationOutput.includes("FAIL WHI-254 IPv4 numeric shortcut is preserved as DNS labels")) {
    throw new Error(`WHI-254 numeric-shortcut canary: paired diagnostic missing\n${normalizationOutput}`);
  }
  console.log("WHI-254 numeric-shortcut canary PASS: FAIL WHI-254 IPv4 numeric shortcut is preserved as DNS labels");

  if (passed !== 3) throw new Error(`WHI-254 canary pass floor: expected 3, reached ${passed}`);
  console.log(`WHI-254 engine mutation canaries PASS: ${passed}/3 named gates.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
