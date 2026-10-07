import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enginePath = resolve(process.env.ENGINE || join(root, "src/engine.mjs"));
const skillsDir = resolve(process.env.SKILLS_DIR || join(root, ".cache/amino-skills"));
const pinPath = resolve(process.env.PIN_FILE || join(root, ".github/amino-skills.pin"));
const manifestPath = resolve(
  process.env.SKILLS_CONTRACT_MANIFEST || join(root, "contracts/skills-corpus-requirements.json"),
);
const fixturesPath = resolve(
  process.env.SKILLS_FIXTURES || join(skillsDir, "conformance/fixtures.json"),
);

function fail(message) {
  console.error(`FAIL WHI-221 skills pin contract: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not read ${label} at ${path}: ${error.message}`);
  }
}

const pin = readFileSync(pinPath, "utf8").replace(/^#.*$/gm, "").trim();
if (!/^[0-9a-f]{40}$/.test(pin)) {
  fail(`pin must be one full lowercase SHA, got ${JSON.stringify(pin)}`);
}

const revision = spawnSync("git", ["-C", skillsDir, "rev-parse", "HEAD"], { encoding: "utf8" });
if (revision.error || revision.status !== 0) {
  fail(`could not prove the checked-out skills revision at ${skillsDir}`);
}
const checkedOut = revision.stdout.trim();
if (checkedOut !== pin) {
  fail(`checked-out skills revision ${checkedOut} does not match pin ${pin}`);
}

const engine = await import(pathToFileURL(enginePath).href);
const version = engine.contractVersion;
if (typeof version !== "string" || version.length === 0) {
  fail("engine does not declare a non-empty contractVersion");
}

const manifest = readJson(manifestPath, "requirements manifest");
const contracts = manifest?.contracts;
if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
  fail("requirements manifest has no contracts map");
}
if (!Object.hasOwn(contracts, version)) {
  fail(`no requirements declared for contract ${version}`);
}
const required = contracts[version];
if (!Array.isArray(required) || required.length === 0) {
  fail(`requirements for contract ${version} must not be empty`);
}
if (required.some((id) => typeof id !== "string" || id.length === 0)) {
  fail(`requirements for contract ${version} must be non-empty row identifiers`);
}
if (new Set(required).size !== required.length) {
  fail(`requirements for contract ${version} contain duplicate row identifiers`);
}

const corpus = readJson(fixturesPath, "pinned corpus");
if (!Array.isArray(corpus?.fixtures)) {
  fail(`pinned corpus at ${fixturesPath} has no fixtures array`);
}
const rowIds = new Set(corpus.fixtures.map((fixture) => fixture?.id));
const missing = required.filter((id) => !rowIds.has(id));
if (missing.length > 0) {
  fail(`contract ${version} missing required corpus rows: ${missing.join(", ")}`);
}

console.log(
  `WHI-221 skills pin contract PASS: ${version} requires ${required.length} rows; all present at ${pin}.`,
);
