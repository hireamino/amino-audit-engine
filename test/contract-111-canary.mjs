import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const runner = resolve(skillsDir, "conformance/run.mjs");
const contract = resolve("test/contract-111.mjs");
const source = readFileSync(enginePath, "utf8");
const temporary = mkdtempSync(join(tmpdir(), "amino-contract-111-canary-"));
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
  console.log(`C111 canary ${name} PASS: ${diagnostic}`);
}

try {
  requireGreen(runContract(enginePath), "C111 healthy control");
  console.log("C111 canary healthy control PASS: all contract 1.11 gates are green.");

  requireRed(
    "empty-source-declaration",
    replaceOnce(
      source,
      ': Object.freeze([group])])),',
      ': Object.freeze(rule === "caa.missing" ? [] : [group])])),',
      "empty source declaration",
    ),
    runContract,
    "rule-evaluation input declaration is empty: caa.missing",
  );

  requireRed(
    "drop-one-tlsa-rule",
    replaceOnce(
      source,
      "    const groups = RULE_INPUTS[rule];",
      '    const groups = rule === "transport.dane_present" ? ["not_transport"] : RULE_INPUTS[rule];',
      "drop one TLSA rule dependency",
    ),
    (engine) => runFixture(engine, "rule-evaluation-tlsa-servfail"),
    "rule-evaluation-tlsa-servfail.not_conclusive_count: expected 4, got 3",
  );

  requireRed(
    "spf-target-treated-as-apex",
    replaceOnce(
      source,
      '    if (rule === "spf.present") {',
      '    if (rule.startsWith("spf.")) {',
      "SPF source precision",
    ),
    (engine) => runFixture(engine, "rule-evaluation-spf-target-servfail", "action"),
    "rule-evaluation-spf-target-servfail.not_conclusive_count: expected 8, got 0",
  );

  requireRed(
    "dmarc-missing-own-only",
    replaceOnce(
      source,
      '  "dmarc.enforced", "dmarc.invalid_policy", "dmarc.monitor_only",',
      '  "dmarc.missing", "dmarc.enforced", "dmarc.invalid_policy", "dmarc.monitor_only",',
      "DMARC missing ancestor dependency",
    ),
    (engine) => runFixture(engine, "rule-evaluation-dmarc-parent-servfail"),
    "rule-evaluation-dmarc-parent-servfail.not_conclusive_count: expected 4, got 3",
  );

  requireRed(
    "drop-dmarc-report-auth-dependency",
    replaceOnce(
      source,
      '    } else if (rule === "dmarc.unauthorized_report_destination") {',
      "    } else if (false) {",
      "DMARC report authorization dependency",
    ),
    (engine) => runFixture(engine, "rule-evaluation-dmarc-report-auth-servfail"),
    "rule-evaluation-dmarc-report-auth-servfail.not_conclusive_count: expected 1, got 0",
  );

  requireRed(
    "ignore-http-503",
    replaceOnce(
      source,
      "    if (response && status !== 429 && !(Number.isInteger(status) && status >= 500)) return;",
      "    if (response) return;",
      "HTTP 5xx dependency",
    ),
    (engine) => runFixture(engine, "rule-evaluation-mta-sts-http-503"),
    "rule-evaluation-mta-sts-http-503.not_conclusive_count: expected 4, got 0",
  );

  requireRed(
    "disable-per-audit-dns-cache",
    replaceOnce(
      source,
      "    if (!dnsCache.has(key)) {",
      "    if (true) {",
      "per-audit DNS cache",
    ),
    runContract,
    "C111 one-read DNS query",
  );

  requireRed(
    "ignore-companion-aaaa-failure",
    replaceOnce(
      source,
      "  function recordDnsFailure(scope, result) {\n    const reason = evaluationDnsFailure(result.name, result.rrtype, result.meta);",
      "  function recordDnsFailure(scope, result) {\n    if (result.rrtype === \"AAAA\") return;\n    const reason = evaluationDnsFailure(result.name, result.rrtype, result.meta);",
      "companion AAAA dependency",
    ),
    runContract,
    "C111 public A does not erase a failed companion AAAA input",
  );

  requireRed(
    "rethrow-dnssec-probe",
    replaceOnce(
      replaceOnce(
        source,
        "        } catch (error) {\n          probeFailure = `DNSSEC probe ${normalizedName}: unavailable`;\n          return {};\n        }",
        "        } catch (error) {\n          throw error;\n        }",
        "throwing DNSSEC probe trace boundary",
      ),
      "  try {\n    evidence = await q.dnssecProbe(domain);\n  } catch (e) {\n    return false;\n  }",
      "  evidence = await q.dnssecProbe(domain);",
      "throwing DNSSEC probe finding boundary",
    ),
    runContract,
    "C111 throwing DNSSEC probe must not abort the audit",
  );

  if (passed !== 9) throw new Error(`C111 canary pass floor: expected 9, got ${passed}`);
  console.log("C111 contract mutation canaries PASS: 9/9 named gates.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
