import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const baselinePath = process.env.BASELINE_ENGINE;
const canonicalPath = process.env.ENGINE || "src/engine.mjs";
if (!baselinePath) {
  console.error("BASELINE_ENGINE is required");
  process.exit(2);
}

const baseline = await import(pathToFileURL(baselinePath).href);
const canonical = await import(pathToFileURL(canonicalPath).href);
if (canonical.contractVersion !== "1.2.0"
  || typeof canonical.createAuditEngine !== "function"
  || typeof canonical.createDefaultAdapters !== "function") {
  throw new Error("contract 1.2.0 production adapter exports are required");
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
    async json() {
      if (value?.jsonError) throw new SyntaxError("invalid JSON fixture");
      return kind === "rdap" ? value?.data : value;
    },
  };
}

function fetchFixture(testCase, calls) {
  return async (rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.hostname === "cloudflare-dns.com") {
      const records = normalizeRecords(typeof testCase.dns === "function" ? testCase.dns() : testCase.dns);
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
    return { output: await run(calls), calls };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

function stripContract12(audit) {
  const copy = structuredClone(audit);
  for (const finding of copy.findings) delete finding.lane;
  delete copy.observations;
  return copy;
}

function aggregate(outputs) {
  const parts = [];
  for (const output of outputs) parts.push(Buffer.from(JSON.stringify(output)), Buffer.from("\n"));
  const bytes = Buffer.concat(parts);
  return { bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") };
}

const cacheDomain = "cache-lifetime.test";
const withoutSpf = baseDns(cacheDomain);
const withSpf = { ...baseDns(cacheDomain), [cacheDomain]: { ...baseDns(cacheDomain)[cacheDomain], TXT: ["v=spf1 -all"] } };
let liveDns = withoutSpf;
const cacheCase = {
  domain: cacheDomain,
  dns: () => liveDns,
  http: { mtaSts: notFound, robots: notFound, rdap: notFound },
};
const hasTitle = (audit, title) => audit.findings.some((finding) => finding.title === title);
const perRequestExpectedTitle = "SPF present";
const perRequest = await withAmbientFixture(cacheCase, async () => {
  liveDns = withoutSpf;
  const first = await canonical.createAuditEngine(canonical.createDefaultAdapters()).auditDomain(cacheDomain);
  liveDns = withSpf;
  const second = await canonical.createAuditEngine(canonical.createDefaultAdapters()).auditDomain(cacheDomain);
  return { first, second };
});
if (!hasTitle(perRequest.output.first, "No SPF record")) {
  throw new Error('B1 per-request audit 1 expected "No SPF record"');
}
if (!hasTitle(perRequest.output.second, perRequestExpectedTitle) || hasTitle(perRequest.output.second, "No SPF record")) {
  throw new Error(`B1 per-request audit 2 expected "${perRequestExpectedTitle}" and no "No SPF record"`);
}
console.log('B1 per-request cache lifetime PASS: audit 1="No SPF record"; audit 2="SPF present".');

const shared = await withAmbientFixture(cacheCase, async (calls) => {
  liveDns = withoutSpf;
  const engine = canonical.createAuditEngine(canonical.createDefaultAdapters());
  const first = await engine.auditDomain(cacheDomain);
  liveDns = withSpf;
  const beforeSecond = calls.filter((call) => call.startsWith("dns:")).length;
  const second = await engine.auditDomain(cacheDomain);
  const afterSecond = calls.filter((call) => call.startsWith("dns:")).length;
  return { first, second, secondDnsFetches: afterSecond - beforeSecond };
});
if (!hasTitle(shared.output.first, "No SPF record") || !hasTitle(shared.output.second, "No SPF record")) {
  throw new Error('B1 shared engine must pin the audit-1 "No SPF record" result in audit 2');
}
if (hasTitle(shared.output.second, "SPF present") || shared.output.secondDnsFetches !== 0) {
  throw new Error(`B1 shared engine expected stale "No SPF record" and 0 audit-2 DNS fetches, got ${shared.output.secondDnsFetches}`);
}
console.log('B1 shared cache lifetime PINNED: audit 2="No SPF record" with 0 DNS fetches after SPF publication.');

const productionOutputs = new Map();
for (const testCase of cases) {
  const before = await withAmbientFixture(testCase, () => baseline.auditDomain(testCase.domain));
  const after = await withAmbientFixture(testCase, () => {
    const engine = canonical.createAuditEngine(canonical.createDefaultAdapters());
    return engine.auditDomain(testCase.domain);
  });
  const compatibility = await withAmbientFixture(testCase, () => canonical.auditDomain(testCase.domain));
  const beforeBytes = Buffer.from(JSON.stringify(before.output));
  const afterBytes = Buffer.from(JSON.stringify(after.output));
  const strippedBytes = Buffer.from(JSON.stringify(stripContract12(after.output)));
  const compatibilityBytes = Buffer.from(JSON.stringify(compatibility.output));
  if (!beforeBytes.equals(strippedBytes)) throw new Error(`G9 ${testCase.id}: baseline and createDefaultAdapters outputs differ after stripping 1.2 fields`);
  if (!afterBytes.equals(compatibilityBytes)) throw new Error(`G9 ${testCase.id}: canonical no-q compatibility and createDefaultAdapters outputs differ`);
  productionOutputs.set(testCase.id, after.output);
  console.log(`G9 PASS ${testCase.id}: ${afterBytes.length} bytes, baseline fetches=${before.calls.length}, canonical fetches=${after.calls.length}`);
}
const productionFull = aggregate([...productionOutputs.values()]);
const productionStripped = aggregate([...productionOutputs.values()].map(stripContract12));
if (productionFull.bytes !== 36324 || productionFull.hash !== "abb345442d560e102ec1b0f4fc031fab88c3cb06a2bddc33f77a9d2f5df97ba7") {
  throw new Error(`G9 contract 1.2 production aggregate changed: ${productionFull.bytes} bytes ${productionFull.hash}`);
}
if (productionStripped.bytes !== 34186 || productionStripped.hash !== "41cbc4629431f55345862f8cbf92668326cff3c8ef0b517cffd97259ffc9e6a4") {
  throw new Error(`G9 stripped production aggregate changed: ${productionStripped.bytes} bytes ${productionStripped.hash}`);
}
console.log(`G9 production aggregate: ${productionFull.bytes} bytes, SHA-256 ${productionFull.hash}`);
console.log(`G9 stripped production aggregate: ${productionStripped.bytes} bytes, SHA-256 ${productionStripped.hash}`);
console.log(`G9 production calling convention PASS: ${cases.length}/6 exact after stripping only 1.2 fields.`);
console.log(`G9 no-q compatibility path PASS: ${cases.length}/6 byte-identical to the injected 1.2 interface.`);

const observationCases = [
  {
    id: "response-404",
    addresses: ["93.184.216.34"],
    http: { mtaSts: notFound, robots: notFound, rdap: notFound },
    expected: { mta_sts_policy: "checked", robots: "checked", rdap: "checked" },
    calls: { mtaSts: 1, robots: 1, rdap: 1 },
  },
  {
    id: "network-error",
    addresses: ["93.184.216.34"],
    http: { mtaSts: "throw", robots: "throw", rdap: "throw" },
    expected: { mta_sts_policy: "unavailable", robots: "unavailable", rdap: "unavailable" },
    calls: { mtaSts: 1, robots: 1, rdap: 1 },
  },
  {
    id: "no-host-address",
    addresses: [],
    http: { mtaSts: notFound, robots: notFound, rdap: notFound },
    expected: { mta_sts_policy: "unavailable", robots: "unavailable", rdap: "checked" },
    calls: { mtaSts: 0, robots: 0, rdap: 1 },
  },
  {
    id: "private-address",
    addresses: ["10.0.0.5"],
    http: { mtaSts: notFound, robots: notFound, rdap: notFound },
    expected: { mta_sts_policy: "unavailable", robots: "unavailable", rdap: "checked" },
    calls: { mtaSts: 0, robots: 0, rdap: 1 },
  },
  {
    id: "mixed-public-private",
    addresses: ["93.184.216.34", "10.0.0.5"],
    http: { mtaSts: notFound, robots: notFound, rdap: notFound },
    expected: { mta_sts_policy: "unavailable", robots: "unavailable", rdap: "checked" },
    calls: { mtaSts: 0, robots: 0, rdap: 1 },
  },
  {
    id: "shared-address-space",
    addresses: ["100.64.0.1"],
    http: { mtaSts: notFound, robots: notFound, rdap: notFound },
    expected: { mta_sts_policy: "unavailable", robots: "unavailable", rdap: "checked" },
    calls: { mtaSts: 0, robots: 0, rdap: 1 },
  },
  {
    id: "mta-sts-invalid-policy",
    addresses: ["93.184.216.34"],
    http: { mtaSts: okText("not an MTA-STS policy"), robots: notFound, rdap: notFound },
    expected: { mta_sts_policy: "checked", robots: "checked", rdap: "checked" },
    calls: { mtaSts: 1, robots: 1, rdap: 1 },
    requiredTitle: "MTA-STS policy is malformed",
  },
  {
    id: "mta-sts-wrong-content-type",
    addresses: ["93.184.216.34"],
    http: {
      mtaSts: {
        status: 200,
        contentType: "text/html",
        body: "version: STSv1\nmode: enforce\nmx: mx.mta-sts-wrong-content-type.test\nmax_age: 86400\n",
      },
      robots: notFound,
      rdap: notFound,
    },
    expected: { mta_sts_policy: "checked", robots: "checked", rdap: "checked" },
    calls: { mtaSts: 1, robots: 1, rdap: 1 },
    requiredTitle: "MTA-STS TXT present but policy file not retrievable",
  },
  {
    id: "robots-non-robots-body",
    addresses: ["93.184.216.34"],
    http: {
      mtaSts: notFound,
      robots: { status: 200, body: "This is an ordinary HTML response, not robots directives." },
      rdap: notFound,
    },
    expected: { mta_sts_policy: "checked", robots: "checked", rdap: "checked" },
    calls: { mtaSts: 1, robots: 1, rdap: 1 },
    forbiddenTitle: "robots.txt blocks AI crawlers",
  },
  {
    id: "rdap-invalid-json",
    addresses: ["93.184.216.34"],
    http: { mtaSts: notFound, robots: notFound, rdap: { status: 200, jsonError: true } },
    expected: { mta_sts_policy: "checked", robots: "checked", rdap: "checked" },
    calls: { mtaSts: 1, robots: 1, rdap: 1 },
    forbiddenArea: "Reputation",
  },
  {
    id: "null-mx-mta-sts",
    addresses: ["93.184.216.34"],
    dns: (domain) => ({
      [domain]: { A: ["93.184.216.34"], MX: ["0 ."] },
      [`_mta-sts.${domain}`]: { TXT: ["v=STSv1; id=null-mx"] },
      [`mta-sts.${domain}`]: { A: ["93.184.216.34"] },
    }),
    http: {
      mtaSts: okText("version: STSv1\nmode: enforce\nmx: mx.null-mx-mta-sts.test\nmax_age: 86400\n"),
      robots: notFound,
      rdap: notFound,
    },
    expected: { mta_sts_policy: "not_applicable", robots: "checked", rdap: "checked" },
    calls: { mtaSts: 0, robots: 1, rdap: 1 },
  },
];

for (const spec of observationCases) {
  const domain = `${spec.id}.test`;
  const testCase = {
    domain,
    dns: spec.dns ? spec.dns(domain) : {
      [domain]: { A: spec.addresses, MX: [`10 mx.${domain}.`] },
      [`mx.${domain}`]: { A: ["93.184.216.34"] },
      [`_mta-sts.${domain}`]: { TXT: ["v=STSv1; id=observation"] },
      [`mta-sts.${domain}`]: { A: spec.addresses },
    },
    http: spec.http,
  };
  const before = await withAmbientFixture(testCase, () => baseline.auditDomain(domain));
  const after = await withAmbientFixture(testCase, () =>
    canonical.createAuditEngine(canonical.createDefaultAdapters()).auditDomain(domain));
  if (JSON.stringify(before.output) !== JSON.stringify(stripContract12(after.output))) {
    throw new Error(`B3 ${spec.id}: findings changed after stripping 1.2 fields`);
  }
  if (JSON.stringify(after.output.observations) !== JSON.stringify(spec.expected)) {
    throw new Error(`B3 ${spec.id}: observations ${JSON.stringify(after.output.observations)} (exp ${JSON.stringify(spec.expected)})`);
  }
  const actualCalls = Object.fromEntries(Object.keys(spec.calls).map((kind) =>
    [kind, after.calls.filter((call) => call === kind).length]));
  if (JSON.stringify(actualCalls) !== JSON.stringify(spec.calls)) {
    throw new Error(`B3 ${spec.id}: HTTP calls ${JSON.stringify(actualCalls)} (exp ${JSON.stringify(spec.calls)})`);
  }
  if (spec.requiredTitle && !hasTitle(after.output, spec.requiredTitle)) {
    throw new Error(`B3 ${spec.id}: expected finding title "${spec.requiredTitle}"`);
  }
  if (spec.forbiddenTitle && hasTitle(after.output, spec.forbiddenTitle)) {
    throw new Error(`B3 ${spec.id}: unexpected finding title "${spec.forbiddenTitle}"`);
  }
  if (spec.forbiddenArea && after.output.findings.some((finding) => finding.area === spec.forbiddenArea)) {
    throw new Error(`B3 ${spec.id}: unexpected ${spec.forbiddenArea} finding`);
  }
  console.log(`B3 PASS ${spec.id}: ${JSON.stringify(spec.expected)}, HTTP ${JSON.stringify(actualCalls)}`);
}
console.log(`B3 default-adapter observations PASS: ${observationCases.length}/11; refused domain-controlled rows made 0 HTTP fetches.`);

// G10 proves the documented supplied-resolver result differs from the production
// path. It does not detect a compatibility branch that re-enables ambient HTTP
// under denied network; G3 is the independent guard for that regression.
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
