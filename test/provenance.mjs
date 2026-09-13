import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const baselinePath = process.env.BASELINE_ENGINE;
const enginePath = process.env.ENGINE || "src/engine.mjs";
const publicLicense = process.env.PUBLIC_LICENSE;
if (!baselinePath) {
  console.error("BASELINE_ENGINE is required");
  process.exit(2);
}

const provenance = JSON.parse(readFileSync("engine.provenance.json", "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineLines = readFileSync(baselinePath, "utf8").split("\n");
const segment = Buffer.from(
  baselineLines.slice(provenance.source.startLine - 1, provenance.source.endLine).join("\n") + "\n",
);
const engine = readFileSync(enginePath);

const checks = [
  [segment.length === provenance.source.bytes, `source bytes ${segment.length}`],
  [hash(segment) === provenance.source.sha256, `source SHA-256 ${hash(segment)}`],
  [hash(engine) === provenance.artifact.sha256, `artifact SHA-256 ${hash(engine)}`],
  [provenance.contractVersion === "1.1.0", `contractVersion ${provenance.contractVersion}`],
];
if (publicLicense) {
  const license = readFileSync("LICENSE");
  const reference = readFileSync(publicLicense);
  checks.push([license.equals(reference), `LICENSE byte-identical to ${publicLicense}`]);
}

let failed = false;
for (const [ok, label] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failed = true;
}
console.log(`Canonical artifact: ${engine.length} bytes; source segment: ${segment.length} bytes.`);
console.log("Reviewed transformation classes:");
for (const item of provenance.allowedTransformations) console.log(`  - ${item}`);
if (failed) process.exit(1);
