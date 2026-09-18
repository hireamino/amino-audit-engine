import { pathToFileURL } from "node:url";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const engine = await import(pathToFileURL(enginePath).href);
if (engine.contractVersion !== "1.4.0") {
  throw new Error(`C14 expected contractVersion 1.4.0, got ${engine.contractVersion}`);
}

const now = Date.parse("2026-09-17T00:00:00Z");
const publicAddress = "93.184.216.34";

function dnsFixture(domain, { apex = [], policy = [], meta = {}, noMeta = false, advertised = false } = {}) {
  const records = {
    [domain]: { A: apex, MX: [`10 mx.${domain}.`], TXT: ["v=spf1 -all"] },
    [`mx.${domain}`]: { A: [publicAddress] },
    [`_dmarc.${domain}`]: { TXT: ["v=DMARC1; p=reject"] },
    [`mta-sts.${domain}`]: { A: policy },
  };
  if (advertised) records[`_mta-sts.${domain}`] = { TXT: ["v=STSv1; id=contract-14"] };
  const normalize = (name) => String(name).replace(/\.+$/, "").toLowerCase();
  const dns = {
    async query(name, rrtype) {
      return [...(records[normalize(name)]?.[rrtype] || [])];
    },
  };
  if (!noMeta) {
    dns.meta = async (name, rrtype) => {
      const key = `${rrtype} ${normalize(name)}`;
      return meta[key] || { status: 0, ad: false, error: false };
    };
  }
  return dns;
}

async function websiteRow(spec) {
  const domain = `${spec.id}.invalid`;
  let robotsCalls = 0;
  const audit = await engine.createAuditEngine({
    dns: dnsFixture(domain, spec.dns),
    http: {
      async mtaSts() { return null; },
      async robots() { robotsCalls++; return spec.robotsResponse; },
      async rdap() { return { status: 404, data: null }; },
    },
    clock: { nowMs: () => now },
  }).auditDomain(domain);
  if (audit.observations.robots !== spec.expectedObservation) {
    throw new Error(`C14 ${spec.id}: expected robots ${spec.expectedObservation}, got ${audit.observations.robots}`);
  }
  if (robotsCalls !== spec.expectedCalls) {
    throw new Error(`C14 ${spec.id}: expected ${spec.expectedCalls} robots calls, got ${robotsCalls}`);
  }
  console.log(`C14 PASS ${spec.id}: robots=${spec.expectedObservation}, calls=${robotsCalls}.`);
}

const websiteRows = [
  {
    id: "authoritative-no-address",
    dns: { apex: [] },
    robotsResponse: { status: 404, body: "" },
    expectedObservation: "not_applicable",
    expectedCalls: 0,
  },
  {
    id: "no-meta-port",
    dns: { apex: [], noMeta: true },
    robotsResponse: { status: 404, body: "" },
    expectedObservation: "unavailable",
    expectedCalls: 0,
  },
  {
    id: "address-lookup-failed",
    dns: {
      apex: [],
      meta: { "A address-lookup-failed.invalid": { status: 2, ad: false, error: false } },
    },
    robotsResponse: { status: 404, body: "" },
    expectedObservation: "unavailable",
    expectedCalls: 0,
  },
  {
    id: "address-refused",
    dns: { apex: ["10.0.0.5"] },
    robotsResponse: { status: 404, body: "" },
    expectedObservation: "unavailable",
    expectedCalls: 0,
  },
  {
    id: "robots-fetch-failed",
    dns: { apex: [publicAddress] },
    robotsResponse: null,
    expectedObservation: "unavailable",
    expectedCalls: 1,
  },
  {
    id: "robots-response-404",
    dns: { apex: [publicAddress] },
    robotsResponse: { status: 404, body: "" },
    expectedObservation: "checked",
    expectedCalls: 1,
  },
];

for (const row of websiteRows) await websiteRow(row);

{
  const id = "mta-sts-policy-host-no-address";
  const domain = `${id}.invalid`;
  let policyCalls = 0;
  const audit = await engine.createAuditEngine({
    dns: dnsFixture(domain, { apex: [publicAddress], policy: [], advertised: true }),
    http: {
      async mtaSts() { policyCalls++; return { status: 200, contentType: "text/plain", body: "version: STSv1\nmode: enforce\nmax_age: 86400\n" }; },
      async robots() { return { status: 404, body: "" }; },
      async rdap() { return { status: 404, data: null }; },
    },
    clock: { nowMs: () => now },
  }).auditDomain(domain);
  const finding = audit.findings.find((item) => item.area === "MTA-STS");
  if (audit.observations.mta_sts_policy !== "unavailable") {
    throw new Error(`C14 ${id}: expected mta_sts_policy unavailable, got ${audit.observations.mta_sts_policy}`);
  }
  if (policyCalls !== 0) throw new Error(`C14 ${id}: expected 0 policy calls, got ${policyCalls}`);
  if (finding?.title !== "MTA-STS TXT present but policy file not retrievable") {
    throw new Error(`C14 ${id}: expected existing policy-host finding, got "${finding?.title}"`);
  }
  console.log(`C14 PASS ${id}: mta_sts_policy=unavailable, calls=0, existing finding retained.`);
}

{
  const id = "rdap-bare-object-rejected";
  const domain = `${id}.invalid`;
  const audit = await engine.createAuditEngine({
    dns: dnsFixture(domain, { apex: [publicAddress] }),
    http: {
      async mtaSts() { return null; },
      async robots() { return { status: 404, body: "" }; },
      async rdap() {
        return { events: [{ eventAction: "registration", eventDate: "2026-09-07T00:00:00Z" }] };
      },
    },
    clock: { nowMs: () => now },
  }).auditDomain(domain);
  const reputation = audit.findings.find((item) => item.area === "Reputation");
  if (audit.observations.rdap !== "checked") {
    throw new Error(`C14 ${id}: expected rdap checked, got ${audit.observations.rdap}`);
  }
  if (reputation) {
    throw new Error(`C14 ${id}: expected no Reputation finding, got "${reputation.title}"`);
  }
  console.log(`C14 PASS ${id}: rdap=checked and bare object emitted no Reputation finding.`);
}

console.log("C14 contract 1.4 rows PASS: 8/8.");
