import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const enginePath = resolve(process.env.ENGINE || "src/engine.mjs");
const differential = join(skillsDir, "public-suffix/differential.py");
const anchor = "export function registrableDomain(host) {\n";
const replacement = `${anchor}  if (host === "0x7f.1") return "wrong.invalid"; // WHI-254 differential canary\n`;
const diagnostic = "PSL DIFFERENTIAL FAIL: input='0x7f.1' python='0x7f.1' engine='wrong.invalid'";
const temporary = mkdtempSync(join(tmpdir(), "amino-psl-differential-canary-"));

function run(engine) {
  return spawnSync("python3", [differential, "--engine", engine], {
    cwd: root,
    encoding: "utf8",
  });
}

function output(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

try {
  const healthy = run(enginePath);
  if (healthy.error || healthy.status !== 0
      || !healthy.stdout.includes("PSL DIFFERENTIAL SUMMARY:")
      || !healthy.stdout.includes("0 disagreements")) {
    throw new Error(`healthy differential control failed\n${output(healthy)}`);
  }

  const source = readFileSync(enginePath, "utf8");
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`mutation anchor must occur exactly once, got ${count}`);
  const mutated = join(temporary, "engine.mjs");
  writeFileSync(mutated, source.replace(anchor, () => replacement));
  const result = run(mutated);
  const combined = output(result);
  if (result.error || result.status === null) {
    throw new Error(`mutated differential did not reach a verdict\n${combined}`);
  }
  if (result.status === 0 || !combined.includes(diagnostic)) {
    throw new Error(`differential mutation did not fail through the named input\n${combined}`);
  }
  console.log("PASS JavaScript PSL differential mutation canary: 1/1");
  console.log(diagnostic);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
