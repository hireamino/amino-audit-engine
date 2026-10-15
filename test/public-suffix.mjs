import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const artifactPath = resolve(skillsDir, "public-suffix/public_suffix_rules.tsv");
const expectedHash = "c16d8b621302b8b5c04ad7c6378494e5aec55e8017f87c4e9fc82efe61e1c7cf";
const expectedBytes = 216020;
const start = "// BEGIN GENERATED PUBLIC SUFFIX ARTIFACT\nconst PUBLIC_SUFFIX_ARTIFACT = String.raw`";
const end = "`;\n// END GENERATED PUBLIC SUFFIX ARTIFACT\n";

const source = readFileSync(enginePath, "utf8");
const artifact = readFileSync(artifactPath);
const corpus = JSON.parse(readFileSync(resolve(skillsDir, "conformance/fixtures.json"), "utf8"));
const registrableRootRows = corpus.fixtures.filter((fixture) =>
  Object.hasOwn(fixture.expect || {}, "registrable_root"));
const startIndex = source.indexOf(start);
const endIndex = source.indexOf(end, startIndex + start.length);
if (startIndex < 0 || endIndex < 0 || source.indexOf(start, startIndex + 1) >= 0) {
  throw new Error("PSL embedding delimiters must occur exactly once");
}
const embedded = Buffer.from(source.slice(startIndex + start.length, endIndex), "utf8");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const generator = spawnSync(
  process.execPath,
  [resolve("scripts/generate-public-suffix-embedding.mjs"), "--check"],
  {
    cwd: process.cwd(),
    env: { ...process.env, SKILLS_DIR: skillsDir, ENGINE: enginePath },
    encoding: "utf8",
  },
);
const checks = [
  [artifact.length === expectedBytes, `pinned artifact bytes ${artifact.length}`],
  [hash(artifact) === expectedHash, `pinned artifact SHA-256 ${hash(artifact)}`],
  [embedded.equals(artifact), "embedded artifact is byte-identical to the skills pin"],
  [hash(embedded) === expectedHash, `embedded artifact SHA-256 ${hash(embedded)}`],
  [generator.status === 0, "generator reproduces the committed engine byte-for-byte"],
  [embedded.includes(Buffer.from("// License, v. 2.0.")), "embedded MPL-2.0 notice"],
  [embedded.includes(Buffer.from("// VERSION: 2026-10-01_23-02-52_UTC")), "embedded upstream VERSION"],
  [embedded.includes(Buffer.from("// COMMIT: 6cd82aff889e3d64e5e03bc5c1f43da1934a960a")), "embedded upstream COMMIT"],
];
const engine = await import(pathToFileURL(enginePath).href);
checks.push([engine.contractVersion === "1.6.0", `contractVersion ${engine.contractVersion}`]);
checks.push([typeof engine.registrableDomain === "function", "registrableDomain export"]);
checks.push([registrableRootRows.length === 8, `shared assertion ledger registrableRoot ${registrableRootRows.length}`]);
checks.push([
  registrableRootRows.every((fixture) =>
    engine.registrableDomain(fixture.input.domain) === fixture.expect.registrable_root),
  "all shared registrableRoot expectations match",
]);

let failed = false;
for (const [ok, label] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} WHI-215 ${label}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log("WHI-215 embedded public-suffix artifact PASS");
