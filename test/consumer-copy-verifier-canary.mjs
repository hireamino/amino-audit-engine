import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const verifier = resolve("scripts/verify-consumer-copy.mjs");
const verifyScript = readFileSync("scripts/verify.sh", "utf8");
const expectedCanaries = 9;
const dir = mkdtempSync(join(tmpdir(), "amino-consumer-identity-canary-"));
const canonical = join(dir, "canonical");
const fixtureSkillsPinA = "a".repeat(40);
const fixtureSkillsPinB = "c".repeat(40);
let passedCanaries = 0;

function outputOf(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

function git(args) {
  const result = run("git", ["-C", canonical, ...args]);
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git command failed: git ${args.join(" ")}\n${outputOf(result)}`);
  }
  return result.stdout.trim();
}

function replaceOnce(source, anchor, replacement, label) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  }
  return source.replace(anchor, () => replacement);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function versionOf(bytes) {
  const matches = [
    ...bytes.toString("utf8").matchAll(/export\s+const\s+contractVersion\s*=\s*"([^"]+)"\s*;/g),
  ];
  if (matches.length !== 1) throw new Error(`fixture engine expected one contractVersion, got ${matches.length}`);
  return matches[0][1];
}

function provenance(revision, bytes) {
  return {
    repository: "https://github.com/hireamino/amino-audit-engine.git",
    revision,
    sourcePath: "src/engine.mjs",
    artifactPath: "vendor/amino-audit-engine/engine.mjs",
    bytes: bytes.length,
    sha256: sha256(bytes),
    contractVersion: versionOf(bytes),
    copyPolicy: "The committed artifact is an exact byte copy; provenance never rewrites it.",
  };
}

function makeConsumer(name, { revision, engine, metadata, skillsPin, leak = "" }) {
  const consumer = join(dir, name);
  mkdirSync(join(consumer, ".github/workflows"), { recursive: true });
  mkdirSync(join(consumer, "scripts"), { recursive: true });
  mkdirSync(join(consumer, "test"), { recursive: true });
  mkdirSync(join(consumer, "vendor/amino-audit-engine"), { recursive: true });
  writeFileSync(join(consumer, ".github/amino-audit-engine.pin"), `${revision}\n`);
  writeFileSync(join(consumer, ".github/amino-skills.pin"), `${skillsPin}\n`);
  writeFileSync(join(consumer, ".github/workflows/gate.yml"), "name: fixture\n");
  writeFileSync(join(consumer, "scripts/gate.sh"), "#!/usr/bin/env bash\nset -euo pipefail\n");
  writeFileSync(join(consumer, "test/gate.mjs"), `export const healthy = true;${leak}\n`);
  writeFileSync(join(consumer, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(consumer, "vendor/amino-audit-engine/engine.mjs"), engine);
  writeFileSync(
    join(consumer, "vendor/amino-audit-engine/provenance.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return consumer;
}

function relativeFiles(path, base = path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) return relativeFiles(fullPath, base);
    if (!entry.isFile() || !statSync(fullPath).isFile()) return [];
    return [fullPath.slice(base.length + 1)];
  });
}

function changedPaths(before, after) {
  const paths = [...new Set([...relativeFiles(before), ...relativeFiles(after)])].sort();
  return paths.filter((path) => {
    try {
      return !readFileSync(join(before, path)).equals(readFileSync(join(after, path)));
    } catch {
      return true;
    }
  });
}

function runVerifier(consumer) {
  return run(process.execPath, [verifier], {
    env: {
      ...process.env,
      CANONICAL_ENGINE_ROOT: canonical,
      CONSUMER_ROOT: consumer,
    },
  });
}

function requireGreen(result, diagnostic, label) {
  const output = outputOf(result);
  if (result.error || result.status !== 0 || !output.includes(diagnostic)) {
    throw new Error(`${label}: healthy control did not reach ${JSON.stringify(diagnostic)}\n${output}`);
  }
  console.log(`${label} PASS: ${diagnostic}`);
}

function requireNamedRed(result, diagnostic, label) {
  const output = outputOf(result);
  if (result.error || result.status === null) {
    throw new Error(`${label}: runner did not reach a verdict\n${output}`);
  }
  if (result.status === 0 || !output.includes(diagnostic)) {
    throw new Error(`${label}: mutation did not fail through ${JSON.stringify(diagnostic)}\n${output}`);
  }
  passedCanaries += 1;
  console.log(`${label} PASS: ${diagnostic}`);
}

function wrongHex(value) {
  return `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
}

try {
  const invocation = 'node "$ROOT/test/consumer-copy-verifier-canary.mjs"';
  const invocationCount = verifyScript.split(invocation).length - 1;
  if (invocationCount !== 1) {
    throw new Error(`WHI-266 verifier canary must be wired into verify.sh exactly once, got ${invocationCount}`);
  }

  mkdirSync(join(canonical, "src"), { recursive: true });
  mkdirSync(join(canonical, ".github"), { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "canary@hireamino.invalid"]);
  git(["config", "user.name", "canary"]);
  const engineA = Buffer.from(
    'export const contractVersion = "7.8.9";\nexport const fixtureMarker = "alpha";\n',
  );
  writeFileSync(join(canonical, "src/engine.mjs"), engineA);
  writeFileSync(join(canonical, ".github/amino-skills.pin"), `${fixtureSkillsPinA}\n`);
  git(["add", "src/engine.mjs", ".github/amino-skills.pin"]);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", "fixture-a"]);
  const revisionA = git(["rev-parse", "HEAD"]);
  const provenanceA = provenance(revisionA, engineA);

  const consumerA = makeConsumer("healthy-a", {
    revision: revisionA,
    engine: engineA,
    metadata: provenanceA,
    skillsPin: fixtureSkillsPinA,
  });
  requireGreen(
    runVerifier(consumerA),
    "WHI-266 consumer identity summary: 15 passed, 0 failed",
    "WHI-266 initial-revision healthy control",
  );

  const engineBSource = replaceOnce(
    replaceOnce(
      engineA.toString("utf8"),
      'contractVersion = "7.8.9"',
      'contractVersion = "7.9.0"',
      "alternate contractVersion",
    ),
    'fixtureMarker = "alpha"',
    'fixtureMarker = "beta"',
    "alternate engine bytes",
  );
  const engineB = Buffer.from(engineBSource);
  writeFileSync(join(canonical, "src/engine.mjs"), engineB);
  writeFileSync(join(canonical, ".github/amino-skills.pin"), `${fixtureSkillsPinB}\n`);
  git(["add", "src/engine.mjs", ".github/amino-skills.pin"]);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", "fixture-b"]);
  const revisionB = git(["rev-parse", "HEAD"]);
  const provenanceB = provenance(revisionB, engineB);

  requireNamedRed(
    runVerifier(makeConsumer("pin-only", {
      revision: revisionB,
      engine: engineA,
      metadata: provenanceA,
      skillsPin: fixtureSkillsPinB,
    })),
    "FAIL WHI-266 consumer identity: consumer engine artifact differs byte-for-byte from canonical engine at pin",
    "WHI-266 pin-moved-vendor-stale canary",
  );

  requireNamedRed(
    runVerifier(makeConsumer("provenance-stale", {
      revision: revisionB,
      engine: engineB,
      metadata: provenanceA,
      skillsPin: fixtureSkillsPinB,
    })),
    "FAIL WHI-266 consumer identity: consumer provenance revision does not equal engine pin",
    "WHI-266 pin-and-vendor-moved-provenance-stale canary",
  );

  const drifted = Buffer.from(engineB);
  drifted[drifted.length - 2] ^= 1;
  requireNamedRed(
    runVerifier(makeConsumer("one-byte-drift", {
      revision: revisionB,
      engine: drifted,
      metadata: provenanceB,
      skillsPin: fixtureSkillsPinB,
    })),
    "FAIL WHI-266 consumer identity: consumer engine artifact differs byte-for-byte from canonical engine at pin",
    "WHI-266 one-byte consumer artifact canary",
  );

  requireNamedRed(
    runVerifier(makeConsumer("provenance-sha", {
      revision: revisionB,
      engine: engineB,
      metadata: { ...provenanceB, sha256: wrongHex(provenanceB.sha256) },
      skillsPin: fixtureSkillsPinB,
    })),
    "FAIL WHI-266 consumer identity: consumer provenance SHA-256 does not match canonical artifact",
    "WHI-266 provenance-SHA canary",
  );

  requireNamedRed(
    runVerifier(makeConsumer("provenance-byte-count", {
      revision: revisionB,
      engine: engineB,
      metadata: { ...provenanceB, bytes: provenanceB.bytes + 1 },
      skillsPin: fixtureSkillsPinB,
    })),
    "FAIL WHI-266 consumer identity: consumer provenance byte count does not match canonical artifact",
    "WHI-266 provenance-byte-count canary",
  );

  requireNamedRed(
    runVerifier(makeConsumer("provenance-version", {
      revision: revisionB,
      engine: engineB,
      metadata: { ...provenanceB, contractVersion: `${provenanceB.contractVersion}-wrong` },
      skillsPin: fixtureSkillsPinB,
    })),
    "FAIL WHI-266 consumer identity: consumer provenance contractVersion does not equal canonical export",
    "WHI-266 provenance-version canary",
  );

  requireNamedRed(
    runVerifier(makeConsumer("skills-pin", {
      revision: revisionB,
      engine: engineB,
      metadata: provenanceB,
      skillsPin: fixtureSkillsPinA,
    })),
    "FAIL WHI-266 consumer identity: consumer skills pin does not equal canonical engine skills pin",
    "WHI-266 consumer-skills-pin canary",
  );

  requireNamedRed(
    runVerifier(makeConsumer("checkout-head", {
      revision: revisionA,
      engine: engineA,
      metadata: provenanceA,
      skillsPin: fixtureSkillsPinB,
    })),
    "FAIL WHI-266 consumer identity: checked-out canonical engine revision does not equal engine pin",
    "WHI-266 fetched-HEAD-mismatch canary",
  );

  requireNamedRed(
    runVerifier(makeConsumer("identity-leak", {
      revision: revisionB,
      engine: engineB,
      metadata: provenanceB,
      skillsPin: fixtureSkillsPinB,
      leak: `\nexport const forbidden = "${revisionB}";`,
    })),
    "FAIL WHI-266 consumer identity: engine identity literal leaked into gate test/gate.mjs:2 (engine pin)",
    "WHI-266 gate-identity-leak canary",
  );

  const consumerB = makeConsumer("healthy-b", {
    revision: revisionB,
    engine: engineB,
    metadata: provenanceB,
    skillsPin: fixtureSkillsPinB,
  });
  requireGreen(
    runVerifier(consumerB),
    "WHI-266 consumer identity summary: 15 passed, 0 failed",
    "WHI-266 different-revision four-path healthy control",
  );
  const delta = changedPaths(consumerA, consumerB);
  const expectedDelta = [
    ".github/amino-audit-engine.pin",
    ".github/amino-skills.pin",
    "vendor/amino-audit-engine/engine.mjs",
    "vendor/amino-audit-engine/provenance.json",
  ];
  if (JSON.stringify(delta) !== JSON.stringify(expectedDelta)) {
    throw new Error(
      `WHI-266 dry-run delta: expected ${JSON.stringify(expectedDelta)}, got ${JSON.stringify(delta)}`,
    );
  }
  console.log(
    `WHI-266 dry-run delta PASS: ${delta.join(", ")}; ` +
      `${engineA.length} -> ${engineB.length} bytes; ${revisionA} -> ${revisionB}.`,
  );

  if (passedCanaries !== expectedCanaries) {
    throw new Error(
      `WHI-266 canary pass floor: expected ${expectedCanaries}, reached ${passedCanaries}`,
    );
  }
  console.log(`WHI-266 consumer identity canaries PASS: ${passedCanaries}/${expectedCanaries}.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
