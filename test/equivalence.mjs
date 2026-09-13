import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const skillsDir = process.env.SKILLS_DIR;
const baselinePath = process.env.BASELINE_ENGINE;
const canonicalPath = process.env.ENGINE || "src/engine.mjs";
if (!skillsDir || !baselinePath) {
  console.error("SKILLS_DIR and BASELINE_ENGINE are required");
  process.exit(2);
}

const baseline = await import(pathToFileURL(baselinePath).href);
const canonical = await import(pathToFileURL(canonicalPath).href);
if (canonical.contractVersion !== "1.0.0" || typeof canonical.createAuditEngine !== "function") {
  throw new Error("canonical engine must export contractVersion=1.0.0 and createAuditEngine()");
}

const corpus = JSON.parse(readFileSync(`${skillsDir}/conformance/fixtures.json`, "utf8"));
const corpusCases = corpus.fixtures
  .filter((fixture) => fixture.mode === "dns-engine")
  .map((fixture) => ({
    id: `corpus-${fixture.id}`,
    domain: fixture.input.domain,
    dns: fixture.input.dns,
    http: { mtaSts: "throw", robots: "throw", rdap: "throw" },
  }));

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
const scenarios = [
  {
    id: "http-mta-sts-valid",
    domain: "mta-valid.test",
    dns: mtaDns("mta-valid.test"),
    http: {
      mtaSts: okText("version: STSv1\nmode: enforce\nmx: mx.mta-valid.test\nmax_age: 86400\n"),
      robots: notFound,
      rdap: notFound,
    },
  },
  {
    id: "http-mta-sts-problems",
    domain: "mta-bad.test",
    dns: mtaDns("mta-bad.test"),
    http: {
      mtaSts: okText("version: STSv0\nmode: enforce\n"),
      robots: notFound,
      rdap: notFound,
    },
  },
  {
    id: "http-robots-blocked",
    domain: "robots-blocked.test",
    dns: baseDns("robots-blocked.test"),
    http: {
      mtaSts: notFound,
      robots: { status: 200, body: "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow: /\n" },
      rdap: notFound,
    },
  },
  {
    id: "http-rdap-newly-registered",
    domain: "new-domain.test",
    dns: {},
    http: {
      mtaSts: notFound,
      robots: notFound,
      rdap: { status: 200, data: { events: [{ eventAction: "registration", eventDate: "2026-09-01T00:00:00Z" }] } },
    },
  },
  {
    id: "http-rdap-expiring",
    domain: "expiring-domain.test",
    dns: {},
    http: {
      mtaSts: notFound,
      robots: notFound,
      rdap: { status: 200, data: { events: [{ eventAction: "expiration", eventDate: "2026-09-20T00:00:00Z" }] } },
    },
  },
  {
    id: "http-every-port-failing",
    domain: "all-http-fails.test",
    dns: mtaDns("all-http-fails.test"),
    http: { mtaSts: "throw", robots: "throw", rdap: "throw" },
  },
];
const cases = [...corpusCases, ...scenarios];
const frozenNow = Date.parse("2026-09-13T00:00:00Z");

function makeDns(records) {
  const norm = (name) => name.replace(/\.+$/, "").toLowerCase();
  const map = {};
  for (const [name, value] of Object.entries(records || {})) map[norm(name)] = value;
  return {
    async query(name, rrtype) {
      name = norm(name);
      if (map[name]?.[rrtype]) return [...map[name][rrtype]];
      for (const key of Object.keys(map)) {
        if (key.startsWith("*._domainkey.") && name.endsWith(key.slice(1)) && map[key][rrtype]) {
          return [...map[key][rrtype]];
        }
      }
      return [];
    },
    async meta(name) {
      const entry = map[norm(name)] || {};
      return { status: entry.status !== undefined ? entry.status : 0, ad: !!entry.ad, error: false };
    },
  };
}

function fixturePorts(spec, calls = []) {
  const take = (name) => {
    calls.push(name);
    const value = spec[name];
    if (value === "throw") throw new Error(`${name} fixture failure`);
    return value || null;
  };
  return {
    async mtaSts() { return take("mtaSts"); },
    async robots() { return take("robots"); },
    async rdap() {
      const value = take("rdap");
      return value && value.status >= 200 && value.status < 300 ? value.data : null;
    },
  };
}

function responseFrom(value, kind) {
  const status = value?.status ?? 500;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? (value?.contentType || "") : null },
    async text() { return value?.body || ""; },
    async json() { return kind === "rdap" ? value?.data : value; },
  };
}

function fixtureFetch(spec, calls = []) {
  return async (rawUrl) => {
    const url = String(rawUrl);
    let kind;
    if (url.startsWith("https://rdap.org/domain/")) kind = "rdap";
    else if (url.endsWith("/.well-known/mta-sts.txt")) kind = "mtaSts";
    else if (url.endsWith("/robots.txt")) kind = "robots";
    else throw new Error(`unexpected fetch in equivalence fixture: ${url}`);
    calls.push(kind);
    const value = spec[kind];
    if (value === "throw") throw new Error(`${kind} fixture failure`);
    return responseFrom(value, kind);
  };
}

function legacyQuery(dns, http, clock) {
  const q = (name, rrtype) => dns.query(name, rrtype);
  q.meta = (name, rrtype) => dns.meta(name, rrtype);
  if (http) q.http = http;
  if (clock) q.clock = clock;
  return q;
}

async function runBaseline(testCase) {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const calls = [];
  globalThis.fetch = fixtureFetch(testCase.http, calls);
  Date.now = () => frozenNow;
  try {
    const q = legacyQuery(makeDns(testCase.dns));
    const audit = await baseline.auditDomain(testCase.domain, q);
    const score = await baseline.buckets(testCase.domain, q);
    return { audit, score, calls };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

async function runInjected(testCase) {
  const calls = [];
  const dns = makeDns(testCase.dns);
  const engine = canonical.createAuditEngine({
    dns,
    http: fixturePorts(testCase.http, calls),
    clock: { nowMs: () => frozenNow },
  });
  return {
    audit: await engine.auditDomain(testCase.domain),
    score: await engine.buckets(testCase.domain),
    calls,
  };
}

async function runCompatibility(testCase) {
  const dns = makeDns(testCase.dns);
  const q = legacyQuery(dns, fixturePorts(testCase.http), { nowMs: () => frozenNow });
  return {
    audit: await canonical.auditDomain(testCase.domain, q),
    score: await canonical.buckets(testCase.domain, q),
  };
}

const serialized = [];
for (const testCase of cases) {
  const before = await runBaseline(testCase);
  const after = await runInjected(testCase);
  const compatibility = await runCompatibility(testCase);
  const beforeBytes = Buffer.from(JSON.stringify({ audit: before.audit, score: before.score }));
  const afterBytes = Buffer.from(JSON.stringify({ audit: after.audit, score: after.score }));
  const compatibilityBytes = Buffer.from(JSON.stringify(compatibility));
  if (!beforeBytes.equals(afterBytes)) throw new Error(`${testCase.id}: baseline and injected outputs differ`);
  if (!afterBytes.equals(compatibilityBytes)) throw new Error(`${testCase.id}: compatibility and injected outputs differ`);
  const hash = createHash("sha256").update(afterBytes).digest("hex");
  console.log(`PASS ${testCase.id}: ${afterBytes.length} bytes ${hash}`);
  serialized.push(afterBytes, Buffer.from("\n"));
}

const aggregate = Buffer.concat(serialized);
const aggregateHash = createHash("sha256").update(aggregate).digest("hex");
console.log(`Output equivalence PASS: ${cases.length} cases, ${aggregate.length} bytes, SHA-256 ${aggregateHash}`);
console.log("Compatibility exports PASS: byte-identical to injected interface for every case.");
