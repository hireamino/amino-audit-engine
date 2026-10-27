import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const runner = join(skillsDir, "conformance/run.mjs");
const source = readFileSync(enginePath, "utf8");
const engine = await import(pathToFileURL(enginePath).href + `?contract111=${Date.now()}`);

assert.equal(engine.contractVersion, "1.11.0", "C111 contract version");
assert.equal((source.match(/^const RULE_EVALUATION_IDS = /gm) || []).length, 1,
  "C111 closed-world inventory declaration");
assert.equal((source.match(/^const RULE_INPUTS = /gm) || []).length, 1,
  "C111 closed-world source declaration");
assert(source.includes("rule-evaluation input declarations must exactly match the 56-rule inventory"),
  "C111 source declarations must fail closed on inventory drift");
console.log("C111 closed-world source declarations PASS: one inventory and one fail-closed input map.");

const fixtures = [
  "rule-evaluation-no-dns-meta",
  "rule-evaluation-no-dnssec-probe",
  "rule-evaluation-tlsa-servfail",
  "rule-evaluation-spf-target-servfail",
  "rule-evaluation-dmarc-parent-servfail",
  "rule-evaluation-mta-sts-http-503",
  "rule-evaluation-dmarc-report-auth-servfail",
  "rule-evaluation-ptr-forward-servfail",
];

function combined(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

let corpusPassed = 0;
for (const surface of ["web", "action"]) {
  for (const fixture of fixtures) {
    const result = spawnSync(process.execPath, [runner], {
      cwd: process.cwd(),
      env: { ...process.env, ENGINE: enginePath, SURFACE: surface, CONFORMANCE_FIXTURE: fixture },
      encoding: "utf8",
    });
    const output = combined(result);
    if (result.error || result.status !== 0 || !output.includes("1 passed, 0 failed")) {
      throw new Error(`C111 ${surface}/${fixture}: contract row failed\n${output}`);
    }
    corpusPassed += 1;
    console.log(`C111 PASS ${surface}/${fixture}`);
  }
}
assert.equal(corpusPassed, 16, "C111 compact surface-row pass floor");

const normalize = (name) => String(name).replace(/\.+$/, "").toLowerCase();
const key = (name, type) => `${String(type).toUpperCase()}\0${normalize(name)}`;

function adapters({ records = {}, statuses = {}, probe = {}, probeThrows = false } = {}) {
  const queryCalls = new Map();
  const metaCalls = new Map();
  const normalizedRecords = new Map();
  const normalizedStatuses = new Map();
  for (const [entry, rows] of Object.entries(records)) normalizedRecords.set(entry, rows);
  for (const [entry, status] of Object.entries(statuses)) normalizedStatuses.set(entry, status);
  const bump = (map, entry) => map.set(entry, (map.get(entry) || 0) + 1);
  return {
    queryCalls,
    metaCalls,
    value: {
      dns: {
        async query(name, type) {
          const entry = key(name, type);
          bump(queryCalls, entry);
          return structuredClone(normalizedRecords.get(entry) || []);
        },
        async meta(name, type) {
          const entry = key(name, type);
          bump(metaCalls, entry);
          return { status: normalizedStatuses.get(entry) ?? 0, ad: false, error: false };
        },
        async dnssecProbe() {
          if (probeThrows) throw new Error("probe offline");
          return structuredClone(probe);
        },
      },
      http: {
        async mtaSts() { return null; },
        async robots() { return { status: 404, body: "" }; },
        async rdap() { return { status: 404, data: null }; },
      },
      clock: { nowMs: () => 1767225600000 },
    },
  };
}

const oneRead = adapters({
  records: {
    [key("one-read.invalid", "A")]: ["93.184.216.34"],
    [key("one-read.invalid", "MX")]: ["10 mx.one-read.invalid."],
    [key("mx.one-read.invalid", "A")]: ["93.184.216.35"],
  },
});
const oneReadResult = await engine.createAuditEngine(oneRead.value).auditDomain("one-read.invalid");
assert.equal(Object.keys(oneReadResult.rule_evaluation).length, 56,
  "C111 one-read result must expose exactly 56 rule evaluations");
for (const [entry, count] of oneRead.queryCalls) {
  assert.equal(count, 1, `C111 one-read DNS query ${entry}: expected 1, got ${count}`);
}
for (const [entry, count] of oneRead.metaCalls) {
  assert.equal(count, 1, `C111 one-read DNS metadata ${entry}: expected 1, got ${count}`);
}
assert.equal(oneRead.queryCalls.get(key("one-read.invalid", "MX")), 1,
  "C111 one-read apex MX lookup must be shared across rules");
console.log(`C111 one-read cache PASS: ${oneRead.queryCalls.size} unique DNS inputs, each read once.`);

const throwingProbe = adapters({
  records: { [key("throwing-probe.invalid", "A")]: ["93.184.216.34"] },
  statuses: { [key("throwing-probe.invalid", "DNSKEY")]: 2 },
  probeThrows: true,
});
const throwingResult = await engine.createAuditEngine(throwingProbe.value).auditDomain("throwing-probe.invalid");
const throwingRules = Object.entries(throwingResult.rule_evaluation)
  .filter(([, value]) => value !== "conclusive")
  .map(([rule]) => rule)
  .filter((rule) => rule.startsWith("dnssec."))
  .sort();
assert.deepEqual(throwingRules, ["dnssec.enabled", "dnssec.missing", "dnssec.validation_failing"],
  "C111 throwing DNSSEC probe must mark exactly three DNSSEC rules non-conclusive");
console.log("C111 throwing DNSSEC probe PASS: audit returns with exactly three non-conclusive DNSSEC rules.");

const bogusEvidence = {
  cloudflare: {
    checking_enabled: { status: 2, records: [] },
    checking_disabled: { status: 0, records: ["257 3 13 TEST"] },
  },
  google: {
    checking_enabled: { status: 2, records: [] },
    checking_disabled: { status: 0, records: ["257 3 13 TEST"] },
  },
};
const bogus = adapters({
  records: { [key("bogus.invalid", "A")]: ["93.184.216.34"] },
  statuses: { [key("bogus.invalid", "DNSKEY")]: 2 },
  probe: bogusEvidence,
});
const bogusResult = await engine.createAuditEngine(bogus.value).auditDomain("bogus.invalid");
const bogusFinding = bogusResult.findings.find((finding) => finding.rule_id === "dnssec.validation_failing");
assert.equal(bogusFinding?.action, "Fix DNSSEC signing",
  "C111 bogus DNSSEC action must be Fix DNSSEC signing");

const unsigned = adapters({ records: { [key("unsigned.invalid", "A")]: ["93.184.216.34"] } });
const unsignedResult = await engine.createAuditEngine(unsigned.value).auditDomain("unsigned.invalid");
const unsignedFinding = unsignedResult.findings.find((finding) => finding.rule_id === "dnssec.missing");
assert.equal(unsignedFinding?.action, "Enable DNSSEC",
  "C111 missing DNSSEC action must remain Enable DNSSEC");
console.log("C111 DNSSEC actions PASS: repair broken signing; enable only when missing.");

const aaaa = adapters({
  records: { [key("aaaa-input.invalid", "A")]: ["93.184.216.34"] },
  statuses: { [key("aaaa-input.invalid", "AAAA")]: 2 },
});
const aaaaResult = await engine.createAuditEngine(aaaa.value).auditDomain("aaaa-input.invalid");
assert.equal(aaaaResult.rule_evaluation["ai_visibility.robots_blocks"],
  "AAAA aaaa-input.invalid: SERVFAIL",
  "C111 public A does not erase a failed companion AAAA input");
console.log("C111 A/AAAA dependency PASS: failed companion AAAA remains non-conclusive.");

console.log("C111 contract 1.11 gates PASS: 16 compact rows plus closed-world, cache, probe, action, and A/AAAA controls.");
