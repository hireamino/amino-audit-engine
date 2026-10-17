import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const runner = resolve(skillsDir, "conformance/run.mjs");
const contract = resolve("test/contract-19.mjs");
const source = readFileSync(enginePath, "utf8");
const temporary = mkdtempSync(join(tmpdir(), "amino-contract-19-canary-"));
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
    env: { ...process.env, ENGINE: engine, SKILLS_DIR: skillsDir },
    encoding: "utf8",
  });
}

function runFixture(engine, fixture, surface = "web") {
  return spawnSync(process.execPath, [runner], {
    cwd: root,
    env: { ...process.env, ENGINE: engine, SURFACE: surface, CONFORMANCE_FIXTURE: fixture },
    encoding: "utf8",
  });
}

function requireGreen(result, label) {
  if (result.error || result.status !== 0) throw new Error(`${label}: healthy control failed\n${output(result)}`);
}

function requireRed(name, mutated, fixture, diagnostic, surface = "web") {
  const path = join(temporary, `${name}.mjs`);
  writeFileSync(path, mutated);
  const result = runFixture(path, fixture, surface);
  const combined = output(result);
  if (result.error || result.status === null) throw new Error(`${name}: runner did not reach a verdict\n${combined}`);
  if (result.status === 0 || !combined.includes(diagnostic)) {
    throw new Error(`${name}: mutation did not fail through ${JSON.stringify(diagnostic)}\n${combined}`);
  }
  passed += 1;
  console.log(`C19 canary ${name} PASS: ${diagnostic}`);
}

try {
  requireGreen(runContract(enginePath), "C19 healthy control");
  console.log("C19 canary healthy control PASS: 14/14 surface rows.");

  requireRed(
    "over-mark-every-finding",
    replaceOnce(
      source,
      '    const affected = unconfirmedDependencies.get([name, rrtype].join("\\0")) || new Set();',
      '    const affected = new Set(F.map((finding) => [finding.area, finding.title].join("\\0")));',
      "over-mark every finding",
    ),
    "inconclusive-apex-txt-servfail",
    'inconclusive-apex-txt-servfail.findings[DMARC|No DMARC record].unconfirmed: expected "missing", got "TXT ex.com: SERVFAIL/REFUSED"',
  );

  requireRed(
    "drop-mx-dependencies",
    replaceOnce(
      source,
      '    [[domain, "MX"].join("\\0"), new Set([\n      "Transport\\0No MX records",\n      "MTA-STS\\0No MTA-STS policy",\n      "TLS-RPT\\0No TLS-RPT",\n    ])],',
      '    [[domain, "MX"].join("\\0"), new Set()],',
      "drop MX dependencies",
    ),
    "inconclusive-apex-mx-notimp",
    'inconclusive-apex-mx-notimp.findings[MTA-STS|No MTA-STS policy].unconfirmed: expected "MX ex.com: lookup error", got "missing"',
    "action",
  );

  requireRed(
    "first-failure-only",
    replaceOnce(
      source,
      "  for (const [name, rrtype, reason] of criticalLookupFailures) {",
      "  for (const [name, rrtype, reason] of criticalLookupFailures.slice(0, 1)) {",
      "first failure only",
    ),
    "inconclusive-apex-txt-before-mx",
    'inconclusive-apex-txt-before-mx.findings[MTA-STS|No MTA-STS policy].unconfirmed: expected "MX ex.com: SERVFAIL/REFUSED", got "missing"',
  );

  requireRed(
    "first-reason-for-every-marker",
    replaceOnce(
      source,
      "      if (affected.has([finding.area, finding.title].join(\"\\0\"))) finding.unconfirmed = reason;",
      "      if (affected.has([finding.area, finding.title].join(\"\\0\"))) finding.unconfirmed = inconclusiveReason;",
      "first reason for every marker",
    ),
    "inconclusive-apex-txt-before-mx",
    'inconclusive-apex-txt-before-mx.findings[MTA-STS|No MTA-STS policy].unconfirmed: expected "MX ex.com: SERVFAIL/REFUSED", got "TXT ex.com: SERVFAIL/REFUSED"',
    "action",
  );

  requireRed(
    "last-result-reason",
    replaceOnce(
      source,
      "        if (!inconclusive) {",
      "        if (true) {",
      "last result reason",
    ),
    "inconclusive-apex-txt-before-mx",
    'inconclusive-apex-txt-before-mx.inconclusive_reason: expected "TXT ex.com: SERVFAIL/REFUSED", got "MX ex.com: SERVFAIL/REFUSED"',
  );

  if (passed !== 5) throw new Error(`C19 canary pass floor: expected 5, got ${passed}`);
  console.log("C19 contract 1.9.0 mutation canaries PASS: 5/5 named gates.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
