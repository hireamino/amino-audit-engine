import { pathToFileURL } from "node:url";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const engine = await import(pathToFileURL(enginePath).href);
const RR = { A: 1, MX: 15, TXT: 16, AAAA: 28 };
const unableTitle = "Unable to confirm MTA-STS policy";
const absentTitle = "No MTA-STS policy";

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/dns-json" },
    async json() { return body; },
    async text() { return ""; },
  };
}

async function runRow(spec) {
  const realFetch = globalThis.fetch;
  const domain = `${spec.id}.invalid`;
  let policyFetches = 0;
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.hostname !== "cloudflare-dns.com") {
      if (url.hostname === `mta-sts.${domain}`) {
        policyFetches++;
        return {
          status: 200,
          ok: true,
          headers: { get: () => "text/plain" },
          async json() { return {}; },
          async text() { return `version: STSv1\nmode: enforce\nmax_age: 86400\nmx: mx.${domain}\n`; },
        };
      }
      throw new Error(`unexpected HTTP fetch: ${url}`);
    }
    const name = url.searchParams.get("name");
    const rrtype = url.searchParams.get("type");
    if (name === `_mta-sts.${domain}` && rrtype === "TXT") {
      if (spec.lookup === "throw") throw new Error("fixture DNS transport failure");
      if (spec.lookup === "non-ok") return response(503, {});
      if (spec.lookup === "missing-status") return response(200, { AD: false, Answer: [] });
      const rows = spec.txt ? [spec.txt] : [];
      return response(200, {
        Status: spec.lookup,
        AD: false,
        Answer: rows.map((data) => ({ type: RR.TXT, data: `"${data}"` })),
      });
    }
    let rows = [];
    if ((name === domain || name === `mta-sts.${domain}`) && rrtype === "A") rows = ["93.184.216.36"];
    if (name === domain && rrtype === "MX") rows = spec.nullMx ? ["0 ."] : [`10 mx.${domain}.`];
    if (name === domain && rrtype === "TXT") rows = ["v=spf1 -all"];
    if (name === `_dmarc.${domain}` && rrtype === "TXT") rows = ["v=DMARC1; p=reject"];
    if (name === `mx.${domain}` && rrtype === "A") rows = ["93.184.216.34"];
    if ((name === domain || name === `mta-sts.${domain}`) && rrtype === "AAAA") rows = [];
    return response(200, {
      Status: 0,
      AD: false,
      Answer: rows.map((data) => ({ type: RR[rrtype], data })),
    });
  };
  try {
    const audit = await engine.createAuditEngine(engine.createDefaultAdapters()).auditDomain(domain);
    return { audit, policyFetches };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const rows = [
  { id: "status-2", lookup: 2, title: unableTitle, observation: "unavailable" },
  { id: "status-5", lookup: 5, title: unableTitle, observation: "unavailable" },
  { id: "status-1", lookup: 1, title: unableTitle, observation: "unavailable" },
  { id: "http-non-ok", lookup: "non-ok", title: unableTitle, observation: "unavailable" },
  { id: "fetch-throws", lookup: "throw", title: unableTitle, observation: "unavailable" },
  { id: "missing-status", lookup: "missing-status", title: unableTitle, observation: "unavailable" },
  { id: "status-3", lookup: 3, title: absentTitle, observation: "not_applicable" },
  { id: "status-0-empty", lookup: 0, title: absentTitle, observation: "not_applicable" },
  { id: "null-mx-servfail", lookup: 2, title: "MTA-STS not applicable — domain receives no mail", observation: "not_applicable", nullMx: true },
  { id: "status-0-present", lookup: 0, txt: "v=STSv1; id=positive", title: "MTA-STS present (mode: enforce)", observation: "checked", policyFetches: 1 },
];

for (const spec of rows) {
  const { audit, policyFetches } = await runRow(spec);
  const finding = audit.findings.find((item) => item.area === "MTA-STS");
  if (finding?.title !== spec.title) {
    throw new Error(`S4 ${spec.id}: expected title "${spec.title}", got "${finding?.title}"`);
  }
  if (audit.observations.mta_sts_policy !== spec.observation) {
    throw new Error(`S4 ${spec.id}: expected observation ${spec.observation}, got ${audit.observations.mta_sts_policy}`);
  }
  const expectedPolicyFetches = spec.policyFetches || 0;
  if (policyFetches !== expectedPolicyFetches) {
    throw new Error(`S4 ${spec.id}: expected ${expectedPolicyFetches} policy fetches, got ${policyFetches}`);
  }
  if (audit.inconclusive !== false) {
    throw new Error(`S4 ${spec.id}: expected inconclusive false, got ${audit.inconclusive}`);
  }
  if (audit.inconclusive_reason !== null) {
    throw new Error(`S4 ${spec.id}: expected inconclusive_reason null, got ${audit.inconclusive_reason}`);
  }
  console.log(`S4 PASS ${spec.id}: "${finding.title}", ${spec.observation}, ${expectedPolicyFetches} policy fetches, inconclusive=false/null.`);
}
console.log(`S4 default-adapter lookup outcomes PASS: ${rows.length}/10.`);

const noMetaDomain = "no-meta.invalid";
const noMeta = await engine.createAuditEngine({
  dns: { async query() { return []; } },
  http: {
    async mtaSts() { throw new Error("no-meta policy fetch"); },
    async robots() { return null; },
    async rdap() { return null; },
  },
  clock: { nowMs: () => 0 },
}).auditDomain(noMetaDomain);
const noMetaFinding = noMeta.findings.find((finding) => finding.area === "MTA-STS");
if (noMetaFinding?.title !== absentTitle || noMeta.observations.mta_sts_policy !== "not_applicable") {
  throw new Error(`S2 no-meta compatibility: expected absence/not_applicable, got ${noMetaFinding?.title}/${noMeta.observations.mta_sts_policy}`);
}
console.log('S2 no-meta compatibility PASS: "No MTA-STS policy" / not_applicable.');
