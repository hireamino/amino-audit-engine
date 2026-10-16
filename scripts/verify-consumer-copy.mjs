import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const verifierRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = resolve(process.env.CANONICAL_ENGINE_ROOT || verifierRoot);
const consumerRoot = process.env.CONSUMER_ROOT && resolve(process.env.CONSUMER_ROOT);

let passed = 0;
let failed = 0;

function check(label, condition, detail = "", failureLabel = label) {
  if (condition) {
    console.log(`PASS WHI-266 consumer identity: ${label}`);
    passed += 1;
  } else {
    console.error(
      `FAIL WHI-266 consumer identity: ${failureLabel}${detail ? ` (${detail})` : ""}`,
    );
    failed += 1;
  }
}

function readRequired(path, label) {
  try {
    return readFileSync(path);
  } catch (error) {
    console.error(`FAIL WHI-266 consumer identity: could not read ${label} at ${path} (${error.message})`);
    process.exit(1);
  }
}

function readPin(path, label) {
  const value = readRequired(path, label)
    .toString("utf8")
    .replace(/^[\t ]*#.*$/gm, "")
    .replace(/\s/g, "");
  if (!/^[0-9a-f]{40}$/.test(value)) {
    console.error(
      `FAIL WHI-266 consumer identity: ${label} must contain one full lowercase SHA, got ${JSON.stringify(value)}`,
    );
    process.exit(1);
  }
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readRequired(path, label).toString("utf8"));
  } catch (error) {
    console.error(`FAIL WHI-266 consumer identity: could not parse ${label} at ${path} (${error.message})`);
    process.exit(1);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contractVersion(source, label) {
  const matches = [...source.matchAll(/export\s+const\s+contractVersion\s*=\s*"([^"]+)"\s*;/g)];
  check(`${label} declares exactly one contractVersion`, matches.length === 1, `got ${matches.length}`);
  const version = matches[0]?.[1] || "";
  check(`${label} contractVersion is semantic`, /^\d+\.\d+\.\d+$/.test(version), `got ${JSON.stringify(version)}`);
  return version;
}

function filesUnder(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(join(path, entry.name))
  );
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

if (!consumerRoot) {
  console.error("FAIL WHI-266 consumer identity: CONSUMER_ROOT is required");
  process.exit(1);
}

const enginePinPath = join(consumerRoot, ".github/amino-audit-engine.pin");
const skillsPinPath = join(consumerRoot, ".github/amino-skills.pin");
const shippedPath = join(consumerRoot, "vendor/amino-audit-engine/engine.mjs");
const provenancePath = join(consumerRoot, "vendor/amino-audit-engine/provenance.json");
const canonicalPath = join(canonicalRoot, "src/engine.mjs");
const canonicalSkillsPinPath = join(canonicalRoot, ".github/amino-skills.pin");

const enginePin = readPin(enginePinPath, "consumer engine pin");
const consumerSkillsPin = readPin(skillsPinPath, "consumer skills pin");
const canonicalSkillsPin = readPin(canonicalSkillsPinPath, "canonical engine skills pin");
const canonicalBytes = readRequired(canonicalPath, "canonical engine artifact");
const shippedBytes = readRequired(shippedPath, "consumer engine artifact");
const provenance = readJson(provenancePath, "consumer engine provenance");

const revision = spawnSync("git", ["-C", canonicalRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
if (revision.error || revision.status !== 0) {
  console.error(
    `FAIL WHI-266 consumer identity: could not prove canonical engine checkout revision at ${canonicalRoot}`,
  );
  process.exit(1);
}
const canonicalRevision = revision.stdout.trim();
check(
  "checked-out canonical engine revision equals engine pin",
  canonicalRevision === enginePin,
  `${canonicalRevision} != ${enginePin}`,
  "checked-out canonical engine revision does not equal engine pin",
);

const canonicalSha = sha256(canonicalBytes);
const canonicalVersion = contractVersion(canonicalBytes.toString("utf8"), "canonical engine");
const shippedVersion = contractVersion(shippedBytes.toString("utf8"), "consumer engine artifact");

check(
  "consumer engine artifact is byte-identical to canonical engine at pin",
  shippedBytes.equals(canonicalBytes),
  "expected byte identity",
  "consumer engine artifact differs byte-for-byte from canonical engine at pin",
);
check(
  "consumer provenance revision equals engine pin",
  provenance.revision === enginePin,
  `${provenance.revision} != ${enginePin}`,
  "consumer provenance revision does not equal engine pin",
);
check(
  "consumer provenance byte count matches canonical artifact",
  provenance.bytes === canonicalBytes.length,
  `${provenance.bytes} != ${canonicalBytes.length}`,
  "consumer provenance byte count does not match canonical artifact",
);
check(
  "consumer provenance SHA-256 matches canonical artifact",
  provenance.sha256 === canonicalSha,
  `${provenance.sha256} != ${canonicalSha}`,
  "consumer provenance SHA-256 does not match canonical artifact",
);
check(
  "consumer provenance contractVersion equals canonical export",
  provenance.contractVersion === canonicalVersion && shippedVersion === canonicalVersion,
  `provenance=${provenance.contractVersion}; canonical=${canonicalVersion}; consumer=${shippedVersion}`,
  "consumer provenance contractVersion does not equal canonical export",
);
check(
  "consumer skills pin equals canonical engine skills pin",
  consumerSkillsPin === canonicalSkillsPin,
  `${consumerSkillsPin} != ${canonicalSkillsPin}`,
  "consumer skills pin does not equal canonical engine skills pin",
);
check(
  "consumer provenance repository is canonical",
  provenance.repository === "https://github.com/hireamino/amino-audit-engine.git",
  `got ${JSON.stringify(provenance.repository)}`,
);
check(
  "consumer provenance source path is canonical",
  provenance.sourcePath === "src/engine.mjs",
  `got ${JSON.stringify(provenance.sourcePath)}`,
);
check(
  "consumer provenance artifact path names the shipped copy",
  provenance.artifactPath === "vendor/amino-audit-engine/engine.mjs",
  `got ${JSON.stringify(provenance.artifactPath)}`,
);

const gateRoots = [
  join(consumerRoot, ".github/workflows"),
  join(consumerRoot, "scripts"),
  join(consumerRoot, "test"),
  join(consumerRoot, "package.json"),
];
const identities = [
  ["engine pin", enginePin],
  ["canonical engine SHA-256", canonicalSha],
  ["canonical engine byte count", String(canonicalBytes.length)],
  ["contractVersion", canonicalVersion],
  ["canonical engine skills pin", canonicalSkillsPin],
];
let leaks = 0;
for (const path of gateRoots.flatMap(filesUnder)) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  for (const [label, value] of identities) {
    let offset = source.indexOf(value);
    while (offset !== -1) {
      const location = `${relative(consumerRoot, path)}:${lineNumber(source, offset)}`;
      console.error(
        `FAIL WHI-266 consumer identity: engine identity literal leaked into gate ${location} (${label})`,
      );
      leaks += 1;
      offset = source.indexOf(value, offset + value.length);
    }
  }
}
if (leaks === 0) {
  console.log("PASS WHI-266 consumer identity: no current engine identity literal leaked into gate code");
  passed += 1;
} else {
  failed += leaks;
}

console.log(
  `WHI-266 consumer identity summary: ${passed} passed, ${failed} failed; ` +
    `${canonicalBytes.length} bytes; SHA-256 ${canonicalSha}; contract ${canonicalVersion}.`,
);
if (failed) process.exit(1);
