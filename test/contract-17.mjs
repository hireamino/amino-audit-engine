import { pathToFileURL } from "node:url";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const engine = await import(`${pathToFileURL(enginePath).href}?contract17=${Date.now()}`);
if (engine.contractVersion !== "1.8.0") {
  throw new Error(`C17 expected contractVersion 1.8.0, got ${engine.contractVersion}`);
}

const now = Date.parse("2026-10-16T00:00:00Z");
const ok404 = { status: 404, body: "", contentType: "text/plain" };
let passed = 0;
let failed = 0;

function check(id, condition, detail) {
  if (condition) {
    console.log(`PASS C17 ${id}`);
    passed += 1;
  } else {
    console.error(`FAIL C17 ${id}: ${detail}`);
    failed += 1;
  }
}

function fixture(domain, records = {}, status = 0) {
  const normalized = new Map(
    Object.entries(records).map(([name, value]) => [name.replace(/\.+$/, "").toLowerCase(), value]),
  );
  const dmarcQueries = [];
  const dns = {
    async query(name, rrtype) {
      const key = String(name).replace(/\.+$/, "").toLowerCase();
      if (rrtype === "TXT" && key.startsWith("_dmarc.")) dmarcQueries.push(key);
      return [...(normalized.get(key)?.[rrtype] || [])];
    },
    async meta(name, rrtype) {
      const key = String(name).replace(/\.+$/, "").toLowerCase();
      if (key === domain && rrtype === "A") return { status, ad: false, error: false };
      return { status: 0, ad: false, error: false };
    },
  };
  const adapters = {
    dns,
    http: {
      async mtaSts() { return null; },
      async robots() { return ok404; },
      async rdap() { return { status: 404, data: null }; },
    },
    clock: { nowMs: () => now },
  };
  return { adapters, dmarcQueries };
}

async function run(spec) {
  const domain = spec.domain.toLowerCase();
  const { adapters, dmarcQueries } = fixture(domain, spec.records, spec.status);
  const audit = await engine.createAuditEngine(adapters).auditDomain(domain);
  const dmarc = audit.findings.filter((finding) => finding.area === "DMARC");
  const target = dmarc.find((finding) => finding.title === spec.title);
  check(
    spec.id,
    !!target
      && target.severity === spec.severity
      && spec.absent.every((title) => !dmarc.some((finding) => finding.title === title))
      && (!spec.detailIncludes || target.detail.includes(spec.detailIncludes))
      && (!spec.maxQueries || dmarcQueries.length <= spec.maxQueries)
      && (!spec.exactQueries || dmarcQueries.length === spec.exactQueries)
      && (!spec.prohibitedQuery || !dmarcQueries.includes(spec.prohibitedQuery)),
    `expected ${spec.severity} ${JSON.stringify(spec.title)}; got ${JSON.stringify(dmarc.map((finding) => [finding.severity, finding.title]))}; DMARC queries=${dmarcQueries.length}`,
  );
  if (spec.score) {
    const scored = await engine.createAuditEngine(fixture(domain, spec.records, spec.status).adapters).buckets(domain);
    check(
      `${spec.id} score`,
      Object.entries(spec.score).every(([key, value]) => scored[key] === value),
      `expected ${JSON.stringify(spec.score)}, got ${JSON.stringify(scored)}`,
    );
  }
}

const cases = [
  {
    id: "E1 psd-y strong sp is capped non-pass",
    domain: "shop.myshopify.com",
    records: {
      "shop.myshopify.com": { A: ["93.184.216.34"] },
      "_dmarc.myshopify.com": { TXT: ["v=DMARC1; p=reject; sp=reject; np=reject; psd=y; rua=mailto:d@myshopify.com"] },
    },
    title: "DMARC enforced by platform policy (sp=reject from myshopify.com)",
    severity: "low",
    absent: ["No DMARC record"],
    score: { DMARC: true, DMARC_enforced: true, DMARC_rua: true },
  },
  {
    id: "E2 psd-y weak sp remains high",
    domain: "weak.myshopify.com",
    records: {
      "weak.myshopify.com": { A: ["93.184.216.34"] },
      "_dmarc.myshopify.com": { TXT: ["v=DMARC1; p=reject; sp=none; np=reject; psd=y"] },
    },
    title: "DMARC platform policy is sp=none from myshopify.com",
    severity: "high",
    absent: ["No DMARC record"],
    score: { DMARC: true, DMARC_enforced: false },
  },
  {
    id: "E3 NXDOMAIN selects np",
    domain: "unused.myshopify.com",
    status: 3,
    records: {
      "_dmarc.myshopify.com": { TXT: ["v=DMARC1; p=none; sp=none; np=reject; psd=y"] },
    },
    title: "DMARC enforced by platform policy (np=reject from myshopify.com)",
    severity: "low",
    absent: ["No DMARC record"],
  },
  {
    id: "E6 no ancestor record stays absent",
    domain: "quiet.myshopify.com",
    records: { "quiet.myshopify.com": { A: ["93.184.216.34"] } },
    title: "No DMARC record",
    severity: "critical",
    absent: ["Parent DMARC record observed above registrable root"],
  },
  {
    id: "E7 owner record wins before ancestor",
    domain: "owned.myshopify.com",
    records: {
      "owned.myshopify.com": { A: ["93.184.216.34"] },
      "_dmarc.owned.myshopify.com": { TXT: ["v=DMARC1; p=reject"] },
      "_dmarc.myshopify.com": { TXT: ["v=DMARC1; p=none; sp=none; psd=y"] },
    },
    title: "DMARC enforced (p=reject)",
    severity: "pass",
    absent: ["No DMARC record", "Parent DMARC record observed above registrable root"],
    prohibitedQuery: "_dmarc.myshopify.com",
  },
  {
    id: "E9 organizational record below psd-y wins",
    domain: "tenant.service.gov.uk",
    records: {
      "tenant.service.gov.uk": { A: ["93.184.216.34"] },
      "_dmarc.service.gov.uk": { TXT: ["v=DMARC1; p=none"] },
      "_dmarc.gov.uk": { TXT: ["v=DMARC1; p=reject; sp=reject; np=reject; psd=y"] },
    },
    title: "DMARC platform policy is p=none from service.gov.uk",
    severity: "high",
    absent: ["No DMARC record"],
  },
  {
    id: "E9b unqualified intermediate does not stop psd-y",
    domain: "a.b.c.d.e.f.tenant.service.gov.uk",
    records: {
      "a.b.c.d.e.f.tenant.service.gov.uk": { A: ["93.184.216.34"] },
      "_dmarc.service.gov.uk": { TXT: ["v=DMARC1; p=none"] },
      "_dmarc.uk": { TXT: ["v=DMARC1; p=reject; sp=reject; np=reject; psd=y"] },
    },
    title: "DMARC enforced by platform policy (sp=reject from uk)",
    severity: "low",
    absent: ["No DMARC record"],
    exactQueries: 8,
  },
  {
    id: "E10 failed existence chooses weaker outcome",
    domain: "uncertain.myshopify.com",
    status: 2,
    records: {
      "_dmarc.myshopify.com": { TXT: ["v=DMARC1; p=none; sp=none; np=reject; psd=y"] },
    },
    title: "DMARC platform policy is sp=none from myshopify.com",
    severity: "high",
    absent: ["No DMARC record"],
    detailIncludes: "existence lookup was inconclusive",
  },
  {
    id: "E11 walk includes TLD for existing name",
    domain: "example.gov",
    records: {
      "example.gov": { A: ["93.184.216.34"] },
      "_dmarc.gov": { TXT: ["v=DMARC1; p=reject; sp=none; np=reject; psd=y"] },
    },
    title: "DMARC platform policy is sp=none from gov",
    severity: "high",
    absent: ["No DMARC record"],
  },
  {
    id: "E11b walk includes TLD for NXDOMAIN",
    domain: "unused.gov",
    status: 3,
    records: {
      "_dmarc.gov": { TXT: ["v=DMARC1; p=reject; sp=none; np=reject; psd=y"] },
    },
    title: "DMARC enforced by platform policy (np=reject from gov)",
    severity: "low",
    absent: ["No DMARC record"],
  },
];

for (const spec of cases) await run(spec);

console.log(`C17 contract 1.7 harness: ${passed} passed, ${failed} failed; expected 12 checks across 10 cases.`);
if (passed !== 12 || failed) process.exitCode = 1;
