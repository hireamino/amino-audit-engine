import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const skillsDir = process.env.SKILLS_DIR;
const enginePath = process.env.ENGINE || "src/engine.mjs";
if (!skillsDir) {
  console.error("SKILLS_DIR is required");
  process.exit(2);
}

const engine = await import(pathToFileURL(enginePath).href);
const contract = JSON.parse(readFileSync(join(skillsDir, "conformance/address-contract.json"), "utf8"));
const listKeys = ["ipv4NonPublic", "ipv6PublicWithin", "ipv6NonPublicWithinPublic", "ipv4MappedWithin"];
if (process.env.SKIP_TABLE_EQUALITY !== "1") {
  if (!Object.isFrozen(engine.addressContract)
      || !listKeys.every((key) => Object.isFrozen(engine.addressContract?.[key]))) {
    throw new Error("ADDRESS table and all four lists must be frozen");
  }
  for (const key of listKeys) {
    try {
      assert.deepEqual(engine.addressContract?.[key], contract[key]);
    } catch {
      throw new Error(`ADDRESS table ${key} differs from pinned skills contract`);
    }
  }
  console.log(`ADDRESS table equality PASS: ${listKeys.length}/4 frozen lists match the pinned skills contract.`);
}

async function engineVerdict(addresses) {
  const domain = "address-contract.invalid";
  let robotsCalls = 0;
  const dns = {
    async query(name, rrtype) {
      if (name !== domain) return [];
      if (rrtype === "A") return addresses.filter((value) => !String(value).includes(":"));
      if (rrtype === "AAAA") return addresses.filter((value) => String(value).includes(":"));
      return [];
    },
    async meta() { return { status: 0, ad: false, error: false }; },
  };
  const audit = await engine.createAuditEngine({
    dns,
    http: {
      async mtaSts() { throw new Error("MTA-STS port must not be called"); },
      async robots() { robotsCalls++; return { status: 404, body: "" }; },
      async rdap() { return { status: 404, data: null }; },
    },
    clock: { nowMs: () => 0 },
  }).auditDomain(domain);
  return { verdict: audit.observations.robots === "checked" ? "allow" : "refuse", robotsCalls };
}

let allowedRows = 0;
let refusedRows = 0;
for (const row of contract.rows) {
  const actual = await engineVerdict(row.addresses);
  const expectedCalls = row.expect === "allow" ? 1 : 0;
  if (actual.verdict !== row.expect || actual.robotsCalls !== expectedCalls) {
    throw new Error(`ADDRESS row ${row.id}: expected ${row.expect}/${expectedCalls} robots calls, got ${actual.verdict}/${actual.robotsCalls}`);
  }
  if (row.expect === "allow") allowedRows++;
  else refusedRows++;
}
console.log(`ADDRESS rows PASS: ${contract.rows.length}/114 through createAuditEngine; allow=${allowedRows}, refuse=${refusedRows}, robots calls=${allowedRows}.`);

const differential = [
  ["::FFFF:7F00:1", "refuse"], ["01.2.3.4", "refuse"],
  ["::ffff:5db8:d822", "allow"], ["1.2.3", "refuse"],
  ["::ffff:224.0.0.1", "refuse"], ["256.1.1.1", "refuse"],
  ["192.88.99.1", "refuse"], ["1.2.3.4.5", "refuse"],
  ["2002:5db8:d822::1", "refuse"], ["93.184.216.34.", "refuse"],
  ["fec0::1", "refuse"], ["0x5d.184.216.34", "refuse"],
  ["ff02::1", "refuse"], ["[2606:4700::1111]", "refuse"],
  ["fd00::1", "refuse"], ["2606:4700::1111/128", "refuse"],
  ["2001:0:1::1", "refuse"], ["1:2:3:4:5:6:7:8:9", "refuse"],
  ["4000::1", "refuse"], ["2606::4700::1", "refuse"],
  ["3fff:1000::1", "allow"], ["2606:47000::1", "refuse"],
  ["3fff:0fff:ffff::1", "refuse"], ["::ffff:93.184.216.034", "refuse"],
  ["2606:4700::1111", "allow"], ["64:ff9b::93.184.216.34", "refuse"],
  ["2606:4700:0000:0000:0000:0000:0000:1111", "allow"], ["::93.184.216.34", "refuse"],
  ["2606:4700::0:1111", "allow"], ["2000::", "allow"],
  ["::ffff:0:0", "refuse"], ["1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "refuse"],
  ["::ffff:0.0.0.0", "refuse"], ["::ffff:1.0.0.0", "allow"],
  ["2606:4700::1111%eth0", "refuse", "allow"], ["2606:4700::1111%1", "refuse", "allow"],
];

for (const [address, expected] of differential) {
  const actual = await engineVerdict([address]);
  const expectedCalls = expected === "allow" ? 1 : 0;
  if (actual.verdict !== expected || actual.robotsCalls !== expectedCalls) {
    throw new Error(`DIFFERENTIAL ${address}: expected ${expected}/${expectedCalls} robots calls, got ${actual.verdict}/${actual.robotsCalls}`);
  }
}

const auditPath = join(skillsDir, "amino-deliverability-audit/skills/amino-deliverability-audit/scripts/audit.py");
const python = String.raw`
import importlib.util, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(path.parent))
spec = importlib.util.spec_from_file_location("audit_contract_probe", path)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
rows = json.loads(sys.argv[2])
out = []
for address, _expected, *rest in rows:
    audit.dig = lambda _host, rrtype, value=address: [value] if rrtype == "A" else []
    out.append(bool(audit.host_public_ips("address-contract.invalid")))
print(json.dumps(out))
`;
const pythonRun = spawnSync("python3", ["-c", python, auditPath, JSON.stringify(differential)], { encoding: "utf8" });
if (pythonRun.error || pythonRun.status !== 0) {
  throw new Error(`DIFFERENTIAL Python probe failed: ${pythonRun.error || pythonRun.stderr}`);
}
const pythonVerdicts = JSON.parse(pythonRun.stdout);
for (let i = 0; i < differential.length; i++) {
  const [address, expected, pythonException] = differential[i];
  const pythonExpected = (pythonException || expected) === "allow";
  if (pythonVerdicts[i] !== pythonExpected) {
    throw new Error(`DIFFERENTIAL Python ${address}: expected ${pythonExpected ? "allow" : "refuse"}, got ${pythonVerdicts[i] ? "allow" : "refuse"}`);
  }
}
console.log(`DIFFERENTIAL PASS: ${differential.length}/36 engine forms; Python agrees on 34/34 shared verdicts; 2/2 approved zone-ID differences observed.`);

for (const address of [":1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:", "1::2:", ":1::2"]) {
  const actual = await engineVerdict([address]);
  if (actual.verdict !== "refuse" || actual.robotsCalls !== 0) {
    throw new Error(`ADDRESS strict-colon ${address}: expected refuse/0 robots calls, got ${actual.verdict}/${actual.robotsCalls}`);
  }
}
console.log("ADDRESS strict-colon syntax PASS: 4/4 malformed single-colon forms refused through the real guard.");
