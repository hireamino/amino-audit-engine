import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const engine = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const runner = join(skillsDir, "conformance/run.mjs");
const source = readFileSync(engine, "utf8");

const fixtures = [
  "inconclusive-tls-rpt-txt-servfail",
  "inconclusive-bimi-txt-servfail",
  "inconclusive-dnskey-both-fail",
  "inconclusive-caa-servfail",
  "inconclusive-dkim-selector-servfail",
  "inconclusive-all-lookups-fail",
  "inconclusive-noncritical-empty-control",
  "dnssec-validation-failing",
  "dnssec-signed-validating-control",
  "spf-failed-include-not-void",
  "finding-id-spf-lookup-12",
  "finding-id-spf-lookup-13",
  "finding-id-dkim-google-selector",
  "dnssec-bogus-provider-consensus",
  "dnssec-ordinary-failure-not-bogus",
  "dnssec-provider-disagreement-not-bogus",
  "dnssec-disabled-evidence-incomplete-not-bogus",
];

const expectedRuleIds = new Set(`
ai_visibility.robots_blocks
bimi.missing
bimi.no_vmc
bimi.present
caa.missing
dkim.invalid_key
dkim.not_found
dkim.present
dkim.testing_mode
dkim.weak_rsa1024
dmarc.enforced
dmarc.inherited_enforced
dmarc.inherited_not_enforced
dmarc.invalid_policy
dmarc.missing
dmarc.monitor_only
dmarc.multiple_records
dmarc.no_rua
dmarc.parent_observed
dmarc.partial_pct
dmarc.removed_tags
dmarc.subdomain_not_enforced
dmarc.unauthorized_report_destination
dnssec.enabled
dnssec.missing
dnssec.validation_failing
mta_sts.malformed
mta_sts.missing
mta_sts.mx_not_covered
mta_sts.not_applicable
mta_sts.policy_unreachable
mta_sts.present
mta_sts.unconfirmed
mx.mixed_providers
reputation.expiring
reputation.new_domain
spf.duplicate_include
spf.lookup_limit
spf.missing
spf.multiple_records
spf.no_all
spf.permissive_all
spf.present
spf.ptr_mechanism
spf.void_limit
tls_rpt.missing
tls_rpt.no_rua
tls_rpt.present
transport.dane_misconfigured
transport.dane_missing
transport.dane_present
transport.dane_unvalidated
transport.no_mx
transport.null_mx
transport.ptr_missing
transport.ptr_not_fcrdns
`.trim().split("\n"));

assert.equal((source.match(/F\.push\(\{/g) || []).length, 1,
  "C110 finding identity source gate: expected one compatibility-shaped direct emit");
assert(source.includes('F.push({ area: "SPF", severity: "high", title: "No SPF record",')
  && source.includes('rule_id: "spf.missing", discriminator: "" });'),
"C110 finding identity source gate: compatibility-shaped SPF emit must declare identity");
assert.equal((source.match(/F\.push\(finding\(/g) || []).length, 55,
  "C110 finding identity source gate: expected 55 helper finding emits");
assert.equal((source.match(/\? \[finding\("mta_sts\.not_applicable"/g) || []).length, 1,
  "C110 finding identity source gate: null-MX finding emit missing");

const namespaces = "ai_visibility|bimi|caa|dkim|dmarc|dnssec|mta_sts|mx|reputation|spf|tls_rpt|transport";
const actualRuleIds = new Set(
  [...source.matchAll(new RegExp(`["]((?:${namespaces})\\.[a-z][a-z0-9_]*)["]`, "g"))]
    .map((match) => match[1]),
);
assert.deepEqual([...actualRuleIds].sort(), [...expectedRuleIds].sort(),
  "C110 finding identity inventory must be exactly 56 stable rule IDs");
console.log("C110 finding identity PASS: 57 emit sites / 56 stable rule IDs.");

const module = await import(pathToFileURL(engine).href + `?contract110=${Date.now()}`);
assert.equal(module.contractVersion, "1.10.0", "C110 contract version");

const originalFetch = globalThis.fetch;
const calls = [];
try {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const disabled = url.searchParams.get("cd") === "1";
    return {
      ok: true,
      async json() {
        return {
          Status: disabled ? 0 : 2,
          AD: false,
          Answer: disabled ? [{ type: 48, data: "257 3 13 TESTKEY" }] : [],
        };
      },
    };
  };
  const evidence = await module.createDefaultAdapters().dns.dnssecProbe("example.com");
  assert.equal(calls.length, 4, "C110 DNSSEC adapter must make four provider/mode requests");
  assert.deepEqual(calls.map((url) => url.hostname).sort(), [
    "cloudflare-dns.com", "cloudflare-dns.com", "dns.google", "dns.google",
  ], "C110 DNSSEC adapter provider independence");
  for (const hostname of ["cloudflare-dns.com", "dns.google"]) {
    const providerCalls = calls.filter((url) => url.hostname === hostname);
    assert.deepEqual(providerCalls.map((url) => url.searchParams.get("cd")).sort(), ["0", "1"],
      `C110 DNSSEC adapter ${hostname} mode independence`);
    assert(providerCalls.every((url) => url.searchParams.get("type") === "DNSKEY"));
  }
  assert.equal(evidence.cloudflare.checking_enabled.status, 2);
  assert.equal(evidence.google.checking_enabled.status, 2);
  assert.equal(evidence.cloudflare.checking_disabled.records.length, 1);
  assert.equal(evidence.google.checking_disabled.records.length, 1);
  console.log("C110 default DNSSEC adapter PASS: four independent provider/mode answers.");
} finally {
  globalThis.fetch = originalFetch;
}

let passed = 0;
for (const surface of ["web", "action"]) {
  for (const fixture of fixtures) {
    const result = spawnSync(process.execPath, [runner], {
      cwd: process.cwd(),
      env: { ...process.env, ENGINE: engine, SURFACE: surface, CONFORMANCE_FIXTURE: fixture },
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.error || result.status !== 0 || !output.includes("1 passed, 0 failed")) {
      throw new Error(`C110 ${surface}/${fixture}: contract row failed\n${output}`);
    }
    passed += 1;
    console.log(`C110 PASS ${surface}/${fixture}`);
  }
}

assert.equal(passed, 34, "C110 surface-row pass floor");
console.log("C110 contract 1.10.0 PASS: 34/34 surface rows.");
