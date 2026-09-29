import { pathToFileURL } from "node:url";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const engine = await import(pathToFileURL(enginePath).href);
if (engine.contractVersion !== "1.5.0") {
  throw new Error(`C15 expected contractVersion 1.5.0, got ${engine.contractVersion}`);
}

const domain = "throwing-address-meta.invalid";
let robotsCalls = 0;
const audit = await engine.createAuditEngine({
  dns: {
    async query(name, rrtype) {
      if (name === domain && ["A", "AAAA"].includes(rrtype)) return [];
      if (name === domain && rrtype === "MX") return [`10 mx.${domain}.`];
      if (name === domain && rrtype === "TXT") return ["v=spf1 -all"];
      if (name === `_dmarc.${domain}` && rrtype === "TXT") return ["v=DMARC1; p=reject"];
      if (name === `mx.${domain}` && rrtype === "A") return ["93.184.216.34"];
      return [];
    },
    async meta(name, rrtype) {
      if (name === domain && ["A", "AAAA"].includes(rrtype)) {
        throw new Error(`fixture ${rrtype} metadata failure`);
      }
      return { status: 0, ad: false, error: false };
    },
  },
  http: {
    async mtaSts() { return null; },
    async robots() { robotsCalls++; return { status: 404, body: "" }; },
    async rdap() { return { status: 404, data: null }; },
  },
  clock: { nowMs: () => Date.parse("2026-09-25T00:00:00Z") },
}).auditDomain(domain);

if (audit.observations.robots !== "unavailable") {
  throw new Error(`C15 throwing-address-meta: expected robots unavailable, got ${audit.observations.robots}`);
}
if (robotsCalls !== 0) {
  throw new Error(`C15 throwing-address-meta: expected 0 robots calls, got ${robotsCalls}`);
}
if (audit.inconclusive !== false || audit.inconclusive_reason !== null) {
  throw new Error(
    `C15 throwing-address-meta: non-critical address metadata changed inconclusive to ${audit.inconclusive}/${audit.inconclusive_reason}`,
  );
}

console.log("C15 PASS throwing-address-meta: robots=unavailable, calls=0, inconclusive=false/null.");
console.log("C15 contract 1.5 rows PASS: 1/1.");
