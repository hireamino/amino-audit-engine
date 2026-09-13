import { pathToFileURL } from "node:url";

const baselinePath = process.env.BASELINE_ENGINE;
const canonicalPath = process.env.ENGINE || "src/engine.mjs";
if (!baselinePath) {
  console.error("BASELINE_ENGINE is required");
  process.exit(2);
}

const baseline = await import(pathToFileURL(baselinePath).href);
const canonical = await import(pathToFileURL(canonicalPath).href);
if (canonical.contractVersion !== "1.1.0"
  || typeof canonical.createAuditEngine !== "function"
  || typeof canonical.createDefaultAdapters !== "function") {
  throw new Error("contract 1.1.0 production adapter exports are required");
}

const frozenNow = Date.parse("2026-09-13T00:00:00Z");
const RR = { A: 1, NS: 2, PTR: 12, SOA: 6, MX: 15, TXT: 16, AAAA: 28, DNSKEY: 48, TLSA: 52, CAA: 257 };
const publicA = ["203.0.113.10"];
const baseDns = (domain) => ({
  [domain]: { A: publicA, MX: [`10 mx.${domain}.`] },
  [`mx.${domain}`]: { A: ["203.0.113.11"] },
});
const mtaDns = (domain) => ({
  ...baseDns(domain),
  [`_mta-sts.${domain}`]: { TXT: ["v=STSv1; id=20260913"] },
  [`mta-sts.${domain}`]: { A: ["203.0.113.12"] },
});
const okText = (body) => ({ status: 200, contentType: "text/plain; charset=utf-8", body });
const notFound = { status: 404, contentType: "text/plain", body: "" };
const cases = [
  {
    id: "mta-sts-valid",
    domain: "mta-valid.test",
    dns: mtaDns("mta-valid.test"),
    http: {
      mtaSts: okText("version: STSv1\nmode: enforce\nmx: mx.mta-valid.test\nmax_age: 86400\n"),
      robots: notFound,
      rdap: notFound,
    },
  },
  {
    id: "mta-sts-problems",
    domain: "mta-bad.test",
    dns: mtaDns("mta-bad.test"),
    http: {
      mtaSts: okText("version: STSv0\nmode: enforce\n"),
      robots: notFound,
      rdap: notFound,
    },
  },
  {
    id: "robots-blocked",
    domain: "robots-blocked.test",
    dns: baseDns("robots-blocked.test"),
    http: {
      mtaSts: notFound,
      robots: { status: 200, body: "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /\n" },
      rdap: notFound,
    },
  },
  {
    id: "rdap-newly-registered",
    domain: "new-domain.test",
    dns: {},
    http: {
      mtaSts: notFound,
      robots: notFound,
      rdap: { status: 200, data: { events: [{ eventAction: "registration", eventDate: "2026-09-01T00:00:00Z" }] } },
    },
  },
  {
    id: "rdap-expiring",
    domain: "expiring-domain.test",
    dns: {},
    http: {
      mtaSts: notFound,
      robots: notFound,
      rdap: { status: 200, data: { events: [{ eventAction: "expiration", eventDate: "2026-09-20T00:00:00Z" }] } },
    },
  },
  {
    id: "all-http-failing",
    domain: "all-http-fails.test",
    dns: mtaDns("all-http-fails.test"),
    http: { mtaSts: "throw", robots: "throw", rdap: "throw" },
  },
];

function normalizeRecords(records) {
  const out = {};
  for (const [name, value] of Object.entries(records || {})) {
    out[name.replace(/\.+$/, "").toLowerCase()] = value;
  }
  return out;
}

function response(value, kind) {
  const status = value?.status ?? 500;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? (value?.contentType || "") : null },
    async text() { return value?.body || ""; },
    async json() { return kind === "rdap" ? value?.data : value; },
  };
}

function fetchFixture(testCase, calls) {
  const records = normalizeRecords(testCase.dns);
  return async (rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.hostname === "cloudflare-dns.com") {
      const name = (url.searchParams.get("name") || "").replace(/\.+$/, "").toLowerCase();
      const rrtype = url.searchParams.get("type");
      calls.push(`dns:${rrtype}:${name}`);
      const entry = records[name] || {};
      const rows = entry[rrtype] || [];
      return response({
        status: 200,
        Status: entry.status ?? 0,
        AD: !!entry.ad,
        Answer: rows.map((data) => ({ type: RR[rrtype], data })),
      }, "doh");
    }

    let kind;
    if (url.hostname === "rdap.org") kind = "rdap";
    else if (url.hostname.startsWith("mta-sts.") && url.pathname === "/.well-known/mta-sts.txt") kind = "mtaSts";
    else if (url.pathname === "/robots.txt") kind = "robots";
    else throw new Error(`unexpected production-adapter fetch: ${url}`);
    calls.push(kind);
    const value = testCase.http[kind];
    if (value === "throw") throw new Error(`${kind} fixture failure`);
    return response(value, kind);
  };
}

function resolver(records) {
  const map = normalizeRecords(records);
  const q = async (name, rrtype) => [...(map[name.replace(/\.+$/, "").toLowerCase()]?.[rrtype] || [])];
  q.meta = async (name) => {
    const entry = map[name.replace(/\.+$/, "").toLowerCase()] || {};
    return { status: entry.status ?? 0, ad: !!entry.ad, error: false };
  };
  return q;
}

async function withAmbientFixture(testCase, run) {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const calls = [];
  globalThis.fetch = fetchFixture(testCase, calls);
  Date.now = () => frozenNow;
  try {
    return { output: await run(), calls };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

const productionOutputs = new Map();
for (const testCase of cases) {
  const before = await withAmbientFixture(testCase, () => baseline.auditDomain(testCase.domain));
  const after = await withAmbientFixture(testCase, () => {
    const engine = canonical.createAuditEngine(canonical.createDefaultAdapters());
    return engine.auditDomain(testCase.domain);
  });
  const beforeBytes = Buffer.from(JSON.stringify(before.output));
  const afterBytes = Buffer.from(JSON.stringify(after.output));
  if (!beforeBytes.equals(afterBytes)) throw new Error(`G9 ${testCase.id}: baseline no-q and createDefaultAdapters outputs differ`);
  productionOutputs.set(testCase.id, after.output);
  console.log(`G9 PASS ${testCase.id}: ${afterBytes.length} bytes, baseline fetches=${before.calls.length}, canonical fetches=${after.calls.length}`);
}
console.log(`G9 production calling convention PASS: ${cases.length}/6 byte-identical.`);

const trapCase = cases.find((testCase) => testCase.id === "mta-sts-valid");
const offline = await canonical.auditDomain(trapCase.domain, resolver(trapCase.dns));
const production = productionOutputs.get(trapCase.id);
const offlineFinding = offline.findings.find((finding) => finding.area === "MTA-STS");
const productionFinding = production.findings.find((finding) => finding.area === "MTA-STS");
if (JSON.stringify(offline) === JSON.stringify(production)) throw new Error("G10 compatibility trap was not detected");
if (offlineFinding?.title !== "MTA-STS TXT present but policy file not retrievable"
  || productionFinding?.title !== "MTA-STS present (mode: enforce)") {
  throw new Error(`G10 unexpected trap evidence: ${JSON.stringify({ offlineFinding, productionFinding })}`);
}
console.log(`G10 trap PASS: offline=[${offlineFinding.severity}] ${offlineFinding.title}; production=[${productionFinding.severity}] ${productionFinding.title}`);

const dedupeCase = { domain: "dedupe.test", dns: { "dedupe.test": { A: ["203.0.113.20"] } }, http: {} };
const dedupe = await withAmbientFixture(dedupeCase, async () => {
  const adapters = canonical.createDefaultAdapters();
  const first = adapters.dns.query("dedupe.test", "A");
  const second = adapters.dns.query("dedupe.test", "A");
  if (first !== second) throw new Error("N4 duplicate in-flight DNS queries did not share one promise");
  return Promise.all([first, second]);
});
const aCalls = dedupe.calls.filter((call) => call === "dns:A:dedupe.test").length;
if (aCalls !== 1) throw new Error(`N4 expected one A fetch, got ${aCalls}`);
console.log("N4 default DNS in-flight deduplication PASS: two callers shared one promise and one fetch.");
