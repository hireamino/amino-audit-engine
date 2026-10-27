#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const artifactPath = resolve(skillsDir, "public-suffix/public_suffix_rules.tsv");
const expectedHash = "08baba1b4bec5ae4efafe69ee967fba494838b45361a04a9e46697c0140defdc";
const expectedBytes = 219788;
const start = "// BEGIN GENERATED PUBLIC SUFFIX ARTIFACT\n";
const end = "// END GENERATED PUBLIC SUFFIX ARTIFACT\n";
const legacyStart = "const PUBLIC_SUFFIX_ARTIFACT = String.raw`";
const legacyEnd = "`;\n\nfunction parsePublicSuffixArtifact";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  console.error(`FAIL WHI-215 public-suffix generator: ${message}`);
  process.exit(1);
}

const artifact = readFileSync(artifactPath);
if (artifact.length !== expectedBytes) fail(`artifact bytes ${artifact.length}, expected ${expectedBytes}`);
if (sha256(artifact) !== expectedHash) fail(`artifact SHA-256 ${sha256(artifact)}, expected ${expectedHash}`);
const text = artifact.toString("utf8");
for (const line of [
  "// This Source Code Form is subject to the terms of the Mozilla Public",
  "// License, v. 2.0.",
  "// VERSION: 2026-10-22_08-36-41_UTC",
  "// COMMIT: 8437e5262f13305f94087abe699b4fe2be1d1de8",
]) {
  if (!text.includes(line)) fail(`artifact is missing provenance line ${JSON.stringify(line)}`);
}
if (text.includes("`") || text.includes("${")) fail("artifact cannot be embedded safely in String.raw");

const source = readFileSync(enginePath, "utf8");
const block = `${start}const PUBLIC_SUFFIX_ARTIFACT = String.raw\`${text}\`;\n${end}`;
let generated;
if (source.includes(start) || source.includes(end)) {
  if (source.split(start).length - 1 !== 1 || source.split(end).length - 1 !== 1) {
    fail("generated delimiters must each occur exactly once");
  }
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex) + end.length;
  generated = source.slice(0, startIndex) + block + source.slice(endIndex);
} else {
  const startIndex = source.indexOf(legacyStart);
  const endIndex = source.indexOf(legacyEnd, startIndex);
  if (startIndex < 0 || endIndex < 0 || source.indexOf(legacyStart, startIndex + 1) >= 0) {
    fail("legacy embedding anchors must occur exactly once");
  }
  generated = source.slice(0, startIndex) + block
    + source.slice(endIndex + 3);
}

if (process.argv.includes("--check")) {
  if (source !== generated) fail("src/engine.mjs is not the deterministic output of this generator");
  console.log(`WHI-215 public-suffix generator CHECK PASS: ${artifact.length} bytes / ${expectedHash}`);
} else {
  writeFileSync(enginePath, generated);
  console.log(`WHI-215 public-suffix generator WRITE PASS: ${artifact.length} bytes / ${expectedHash}`);
}
