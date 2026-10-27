import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const runner = resolve(skillsDir, "conformance/run.mjs");
const contract = resolve("test/contract-110.mjs");
const source = readFileSync(enginePath, "utf8");
const temporary = mkdtempSync(join(tmpdir(), "amino-contract-110-canary-"));
let passed = 0;

function replaceOnce(input, anchor, replacement, label) {
  const count = input.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  return input.replace(anchor, () => replacement);
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function engineCopy(name, mutated) {
  const path = join(temporary, `${name}.mjs`);
  writeFileSync(path, mutated);
  return path;
}

function runFixture(engine, fixture, surface = "web") {
  return spawnSync(process.execPath, [runner], {
    cwd: root,
    env: { ...process.env, ENGINE: engine, SURFACE: surface, CONFORMANCE_FIXTURE: fixture },
    encoding: "utf8",
  });
}

function runContract(engine) {
  return spawnSync(process.execPath, [contract], {
    cwd: root,
    env: { ...process.env, ENGINE: engine, SKILLS_DIR: skillsDir },
    encoding: "utf8",
  });
}

function requireGreen(result, label) {
  if (result.error || result.status !== 0) throw new Error(`${label}: healthy control failed\n${output(result)}`);
}

function requireRed(name, mutated, run, diagnostic) {
  const result = run(engineCopy(name, mutated));
  const combined = output(result);
  if (result.error || result.status === null) throw new Error(`${name}: runner did not reach a verdict\n${combined}`);
  if (result.status === 0 || !combined.includes(diagnostic)) {
    throw new Error(`${name}: mutation did not fail through ${JSON.stringify(diagnostic)}\n${combined}`);
  }
  passed += 1;
  console.log(`C110 canary ${name} PASS: ${diagnostic}`);
}

try {
  requireGreen(runContract(enginePath), "C110 healthy control");
  console.log("C110 canary healthy control PASS: identity, adapter, and 34 surface rows.");

  requireRed(
    "drop-tls-rpt-marker",
    replaceOnce(
      source,
      '[["_smtp._tls." + domain, "TXT"].join("\\0"), new Set(["TLS-RPT\\0No TLS-RPT"])],',
      '[["_smtp._tls." + domain, "TXT"].join("\\0"), new Set()],',
      "drop TLS-RPT marker",
    ),
    (engine) => runFixture(engine, "inconclusive-tls-rpt-txt-servfail"),
    "inconclusive-tls-rpt-txt-servfail.findings[TLS-RPT|No TLS-RPT].unconfirmed",
  );

  requireRed(
    "input-before-own-record",
    replaceOnce(
      source,
      "  failures.push(...criticalFailures);",
      "  failures.unshift(...criticalFailures);",
      "input lookup ahead of own record",
    ),
    (engine) => runFixture(engine, "inconclusive-all-lookups-fail", "action"),
    "inconclusive-all-lookups-fail.findings[TLS-RPT|No TLS-RPT].unconfirmed",
  );

  requireRed(
    "mark-authoritative-empty",
    replaceOnce(
      source,
      "  if (!dnsMetaFailed(meta)) return null;",
      "  if (false) return null;",
      "mark authoritative empty",
    ),
    (engine) => runFixture(engine, "inconclusive-noncritical-empty-control"),
    "inconclusive-noncritical-empty-control.findings[TLS-RPT|No TLS-RPT].unconfirmed",
  );

  requireRed(
    "skip-dnssec-probe",
    replaceOnce(
      source,
      "  } else if (dnsMetaFailed(meta) && await dnssecValidationFailing(domain, q)) {",
      "  } else if (false) {",
      "skip DNSSEC probe",
    ),
    (engine) => runFixture(engine, "dnssec-bogus-provider-consensus"),
    "dnssec-bogus-provider-consensus",
  );

  requireRed(
    "one-provider-enabled",
    replaceOnce(
      source,
      "  const enabledServfail = providers.every(",
      "  const enabledServfail = providers.some(",
      "accept one provider enabled",
    ),
    (engine) => runFixture(engine, "dnssec-provider-disagreement-not-bogus"),
    "dnssec-provider-disagreement-not-bogus",
  );

  requireRed(
    "one-provider-disabled",
    replaceOnce(
      source,
      "  const disabledRecords = providers.every(",
      "  const disabledRecords = providers.some(",
      "accept one provider disabled",
    ),
    (engine) => runFixture(engine, "dnssec-disabled-evidence-incomplete-not-bogus"),
    "dnssec-disabled-evidence-incomplete-not-bogus",
  );

  requireRed(
    "drop-rule-id-emit",
    replaceOnce(
      source,
      'F.push(finding("spf.multiple_records", {',
      'F.push(otherFinding("spf.multiple_records", {',
      "drop rule-id helper from one emit",
    ),
    (engine) => runContract(engine),
    "C110 finding identity source gate: expected 55 helper finding emits",
  );

  requireRed(
    "value-derived-spf-rule-id",
    replaceOnce(
      source,
      'F.push(finding("spf.lookup_limit", {',
      'F.push(finding("spf.lookup_limit_n" + n, {',
      "value-derived SPF rule id",
    ),
    (engine) => runFixture(engine, "finding-id-spf-lookup-12"),
    "finding-id-spf-lookup-12.findings[SPF|SPF exceeds 10 DNS lookups (12)].rule_id",
  );

  requireRed(
    "blank-dkim-discriminator",
    replaceOnce(
      source,
      "  const selector = dkimSelector(note);",
      '  const selector = state === "good" ? "" : dkimSelector(note);',
      "blank DKIM discriminator",
    ),
    (engine) => runFixture(engine, "finding-id-dkim-google-selector", "action"),
    "finding-id-dkim-google-selector.findings[DKIM|DKIM present (DKIM google (RSA-2048))].discriminator",
  );

  requireRed(
    "null-mx-wrong-rule-id",
    replaceOnce(
      source,
      'finding("mta_sts.not_applicable", {',
      'finding("mta_sts.present", {',
      "null-MX wrong rule id",
    ),
    (engine) => runFixture(engine, "null-mx-not-applicable"),
    "null-mx-not-applicable.findings[MTA-STS|MTA-STS not applicable — domain receives no mail].rule_id",
  );

  requireRed(
    "duplicate-dnssec-provider",
    replaceOnce(
      source,
      '    const endpoint = provider === "cloudflare"',
      "    const endpoint = true",
      "duplicate DNSSEC provider",
    ),
    (engine) => runContract(engine),
    "C110 DNSSEC adapter provider independence",
  );

  if (passed !== 11) throw new Error(`C110 canary pass floor: expected 11, got ${passed}`);
  console.log("C110 compatibility mutation canaries PASS: 11/11 named gates.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
