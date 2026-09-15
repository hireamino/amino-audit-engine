import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const source = readFileSync(enginePath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-cache-canary-"));

function count(sourceText, anchor) {
  let found = 0;
  let offset = 0;
  while ((offset = sourceText.indexOf(anchor, offset)) !== -1) {
    found++;
    offset += anchor.length;
  }
  return found;
}

function run(engine) {
  return spawnSync(process.execPath, ["test/default-adapters.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ENGINE: engine },
    encoding: "utf8",
  });
}

function proveMutation({ label, anchor, replacement, diagnostic }) {
  const occurrences = count(source, anchor);
  if (occurrences !== 1) throw new Error(`${label}: engine mutation anchor must occur exactly once, got ${occurrences}`);
  const mutated = join(dir, `${label}.mjs`);
  writeFileSync(mutated, source.replace(anchor, () => replacement));
  const result = run(mutated);
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !combined.includes(diagnostic)) {
    throw new Error(`${label}: engine mutation did not fail with the required diagnostic\n${combined}`);
  }
  console.log(`${label} PASS: ${diagnostic}`);
}

try {
  const healthy = run(enginePath);
  if (healthy.status !== 0) {
    throw new Error(`healthy engine failed the cache-lifetime control\n${healthy.stdout || ""}\n${healthy.stderr || ""}`);
  }
  console.log("B1 healthy control PASS: per-request refresh and shared-engine cache assertions both pass.");

  proveMutation({
    label: "B1-module-scope-cache",
    anchor: "export function createDefaultAdapters() {\n  const cache = new Map();",
    replacement: "const cache = new Map();\nexport function createDefaultAdapters() {",
    diagnostic: 'B1 per-request audit 2 expected "SPF present" and no "No SPF record"',
  });

  proveMutation({
    label: "B1-cache-removed",
    anchor: `    query(name, rrtype) {
      const k = rrtype + " " + name;
      if (!cache.has(k)) cache.set(k, raw(name, rrtype));
      return cache.get(k);
    },`,
    replacement: `    query(name, rrtype) {
      return raw(name, rrtype);
    },`,
    diagnostic: 'B1 shared engine must pin the audit-1 "No SPF record" result in audit 2',
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
