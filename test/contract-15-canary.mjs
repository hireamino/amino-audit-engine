import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const source = readFileSync(enginePath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-contract-15-canary-"));

function replaceOnce(sourceText, anchor, replacement, label) {
  const count = sourceText.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  return sourceText.replace(anchor, () => replacement);
}

function run(engine) {
  return spawnSync(process.execPath, ["test/contract-15.mjs"], {
    cwd: process.cwd(), env: { ...process.env, ENGINE: engine }, encoding: "utf8",
  });
}

try {
  const healthy = run(enginePath);
  const healthyOutput = `${healthy.stdout || ""}\n${healthy.stderr || ""}`;
  if (healthy.status !== 0 || !healthyOutput.includes("C15 contract 1.5 rows PASS: 1/1")) {
    throw new Error(`C15 healthy control failed\n${healthyOutput}`);
  }
  console.log("C15 canary healthy control PASS: 1/1.");

  const mutant = join(dir, "throwing-meta-authoritative-absence.mjs");
  const mutated = replaceOnce(
    source,
    '    } catch (e) {\n      return "lookup_failed";\n    }',
    '    } catch (e) {\n      return "no_answers";\n    }',
    "C15 throwing address metadata",
  );
  writeFileSync(mutant, mutated);
  const result = run(mutant);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const diagnostic = "C15 throwing-address-meta: expected robots unavailable, got not_applicable";
  if (result.error || result.status === null) {
    throw new Error("C15 throwing address metadata: runner did not reach a verdict");
  }
  if (result.status === 0 || !output.includes(diagnostic)) {
    throw new Error(`C15 throwing address metadata: mutation did not fail through the named row\n${output}`);
  }
  console.log(`C15 throwing-meta-authoritative-absence PASS: ${diagnostic}`);
  console.log("C15 contract mutation canaries PASS: 1/1 named row.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
