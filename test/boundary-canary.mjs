import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const source = readFileSync(enginePath, "utf8");
const needle = "left >= 0 && left < 30";
if ((source.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length !== 1) {
  throw new Error("expiry threshold mutation point must occur exactly once");
}

const dir = mkdtempSync(join(tmpdir(), "amino-engine-boundary-canary-"));
const mutated = join(dir, "engine.mjs");
try {
  writeFileSync(mutated, source.replace(needle, "left >= 0 && left < 31"));
  const result = spawnSync(process.execPath, ["test/equivalence.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ENGINE: mutated },
    encoding: "utf8",
  });
  const diagnostic = "boundary-expiry-30: baseline and injected outputs differ";
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !combined.includes(diagnostic)) {
    throw new Error(`30->31 mutation did not fail for the named boundary case\n${combined}`);
  }
  console.log(`Boundary canary PASS: ${diagnostic}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
