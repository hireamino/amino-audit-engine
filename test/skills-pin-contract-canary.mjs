import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const pinPath = resolve(process.env.PIN_FILE || ".github/amino-skills.pin");
const manifestPath = resolve(
  process.env.SKILLS_CONTRACT_MANIFEST || "contracts/skills-corpus-requirements.json",
);
const verifier = resolve("scripts/verify-skills-pin-contract.mjs");
const wiringTest = resolve("test/skills-pin-contract-wiring.mjs");
const fetcher = resolve("scripts/fetch-pinned-skills.sh");
const oldPin = "2558a593ec8aacb816bf3cd91821c32433a3b341";
const expectedCanaries = 5;
let passedCanaries = 0;
const requiredRows = [
  "inconclusive-apex-txt-notimp",
  "inconclusive-dmarc-txt-formerr",
  "inconclusive-apex-mx-notimp",
];
const dir = mkdtempSync(join(tmpdir(), "amino-skills-pin-contract-canary-"));

function replaceOnce(source, anchor, replacement, label) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  }
  return source.replace(anchor, () => replacement);
}

function runVerifier(overrides = {}) {
  return spawnSync(process.execPath, [verifier], {
    cwd: root,
    env: {
      ...process.env,
      ENGINE: enginePath,
      SKILLS_DIR: skillsDir,
      PIN_FILE: pinPath,
      SKILLS_CONTRACT_MANIFEST: manifestPath,
      ...overrides,
    },
    encoding: "utf8",
  });
}

function runWiring(verifyScript) {
  return spawnSync(process.execPath, [wiringTest], {
    cwd: root,
    env: { ...process.env, VERIFY_SCRIPT: verifyScript },
    encoding: "utf8",
  });
}

function outputOf(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function requireGreen(result, diagnostic) {
  const output = outputOf(result);
  if (result.error || result.status !== 0 || !output.includes(diagnostic)) {
    throw new Error(`healthy control did not reach ${JSON.stringify(diagnostic)}\n${output}`);
  }
}

function requireNamedRed(result, diagnostic, label) {
  const output = outputOf(result);
  if (result.error || result.status === null) {
    throw new Error(`${label}: runner did not reach a verdict\n${output}`);
  }
  if (result.status === 0 || !output.includes(diagnostic)) {
    throw new Error(`${label}: mutation did not fail through the named diagnostic\n${output}`);
  }
  passedCanaries += 1;
  console.log(`${label} PASS: ${diagnostic}`);
}

try {
  requireGreen(
    runVerifier(),
    "WHI-221 skills pin contract PASS: 1.5.0 requires 3 rows; all present",
  );
  requireGreen(
    runWiring(resolve("scripts/verify.sh")),
    "WHI-221 verify wiring PASS: self-proving skills-pin gate is invoked exactly once.",
  );
  console.log("WHI-221 healthy controls PASS: pinned corpus contract and verifier wiring.");

  const oldPinFile = join(dir, "old.pin");
  const oldSkills = join(dir, "old-skills");
  writeFileSync(oldPinFile, `${oldPin}\n`);
  const fetch = spawnSync("bash", [fetcher, oldSkills], {
    cwd: root,
    env: { ...process.env, PIN_FILE: oldPinFile },
    encoding: "utf8",
  });
  if (fetch.error || fetch.status !== 0) {
    throw new Error(`original-defect setup could not fetch ${oldPin}\n${outputOf(fetch)}`);
  }
  requireNamedRed(
    runVerifier({ SKILLS_DIR: oldSkills, PIN_FILE: oldPinFile }),
    `FAIL WHI-221 skills pin contract: contract 1.5.0 missing required corpus rows: ${requiredRows.join(", ")}`,
    "WHI-221 original reverted-pin canary",
  );

  const rowRemovedSkills = join(dir, "row-removed-skills");
  cpSync(skillsDir, rowRemovedSkills, { recursive: true });
  const rowRemovedFixtures = join(rowRemovedSkills, "conformance/fixtures.json");
  const corpus = JSON.parse(readFileSync(rowRemovedFixtures, "utf8"));
  const removedId = requiredRows[1];
  const before = corpus.fixtures.length;
  corpus.fixtures = corpus.fixtures.filter((fixture) => fixture.id !== removedId);
  if (corpus.fixtures.length !== before - 1) {
    throw new Error(`row-removed setup expected exactly one ${removedId} fixture`);
  }
  writeFileSync(rowRemovedFixtures, `${JSON.stringify(corpus, null, 2)}\n`);
  requireNamedRed(
    runVerifier({ SKILLS_DIR: rowRemovedSkills }),
    `FAIL WHI-221 skills pin contract: contract 1.5.0 missing required corpus rows: ${removedId}`,
    "WHI-221 missing-row canary",
  );

  const unknownEngine = join(dir, "unknown-contract-engine.mjs");
  const engineSource = readFileSync(enginePath, "utf8");
  writeFileSync(
    unknownEngine,
    replaceOnce(
      engineSource,
      'export const contractVersion = "1.5.0";',
      'export const contractVersion = "9.9.9";',
      "unknown-contract",
    ),
  );
  requireNamedRed(
    runVerifier({ ENGINE: unknownEngine }),
    "FAIL WHI-221 skills pin contract: no requirements declared for contract 9.9.9",
    "WHI-221 unknown-contract canary",
  );

  const emptyManifestPath = join(dir, "empty-requirements.json");
  const emptyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(emptyManifest.contracts?.["1.5.0"])) {
    throw new Error("empty-requirements setup could not find contract 1.5.0");
  }
  emptyManifest.contracts["1.5.0"] = [];
  writeFileSync(emptyManifestPath, `${JSON.stringify(emptyManifest, null, 2)}\n`);
  requireNamedRed(
    runVerifier({ SKILLS_CONTRACT_MANIFEST: emptyManifestPath }),
    "FAIL WHI-221 skills pin contract: requirements for contract 1.5.0 must not be empty",
    "WHI-221 empty-requirements canary",
  );

  const unwiredVerify = join(dir, "verify-unwired.sh");
  const verifySource = readFileSync("scripts/verify.sh", "utf8");
  writeFileSync(
    unwiredVerify,
    replaceOnce(
      verifySource,
      'SKILLS_DIR="$SKILLS_DIR" ENGINE="$ENGINE" node "$ROOT/scripts/verify-skills-pin-contract.mjs"\n',
      "",
      "verify invocation removal",
    ),
  );
  requireNamedRed(
    runWiring(unwiredVerify),
    "FAIL WHI-221 verify wiring: expected exactly one self-proving skills-pin gate invocation, got 0",
    "WHI-221 removed-invocation canary",
  );

  if (passedCanaries !== expectedCanaries) {
    throw new Error(
      `WHI-221 canary pass floor: expected ${expectedCanaries}, reached ${passedCanaries}`,
    );
  }
  console.log(
    `WHI-221 skills-pin contract canaries PASS: ${passedCanaries}/${expectedCanaries} named gates.`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
