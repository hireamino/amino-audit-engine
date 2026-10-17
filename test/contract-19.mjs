import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const engine = resolve(process.env.ENGINE || "src/engine.mjs");
const skillsDir = resolve(process.env.SKILLS_DIR || ".cache/amino-skills");
const runner = join(skillsDir, "conformance/run.mjs");
const fixtures = [
  "inconclusive-apex-txt-servfail",
  "inconclusive-dmarc-txt-refused",
  "inconclusive-apex-mx-servfail",
  "inconclusive-apex-txt-before-mx",
  "inconclusive-apex-txt-notimp",
  "inconclusive-dmarc-txt-formerr",
  "inconclusive-apex-mx-notimp",
];

let passed = 0;
for (const surface of ["web", "action"]) {
  for (const fixture of fixtures) {
    const result = spawnSync(process.execPath, [runner], {
      cwd: process.cwd(),
      env: { ...process.env, ENGINE: engine, SURFACE: surface, CONFORMANCE_FIXTURE: fixture },
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.error || result.status !== 0 || !output.includes("1 passed, 0 failed")) {
      throw new Error(`C19 ${surface}/${fixture}: reviewed marker contract failed\n${output}`);
    }
    passed += 1;
    console.log(`C19 PASS ${surface}/${fixture}`);
  }
}

if (passed !== 14) throw new Error(`C19 pass floor: expected 14, got ${passed}`);
console.log("C19 contract 1.9.0 per-finding inconclusive precision PASS: 14/14 surface rows.");
