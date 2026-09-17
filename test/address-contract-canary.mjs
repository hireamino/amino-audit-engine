import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const source = readFileSync(enginePath, "utf8");
const addressTestPath = "test/address-contract.mjs";
const testSource = readFileSync(addressTestPath, "utf8");
const dir = mkdtempSync(join(tmpdir(), "amino-engine-address-canary-"));

function replaceOnce(input, anchor, replacement, label) {
  const count = input.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label}: mutation anchor must occur exactly once, got ${count}`);
  return input.replace(anchor, () => replacement);
}

function run(engine, testPath = addressTestPath) {
  return spawnSync(process.execPath, [testPath], {
    cwd: process.cwd(),
    env: { ...process.env, ENGINE: engine },
    encoding: "utf8",
  });
}

function prove(label, mutatedSource, diagnostic, testPath = addressTestPath) {
  const file = join(dir, `${label}.mjs`);
  writeFileSync(file, mutatedSource);
  const result = run(file, testPath);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error || result.status === null) throw new Error(`${label}: runner did not reach a verdict`);
  if (result.status === 0 || !output.includes(diagnostic)) {
    throw new Error(`${label}: mutation did not fail through the named address gate\n${output}`);
  }
  console.log(`${label} PASS: ${diagnostic}`);
}

try {
  const healthy = run(enginePath);
  const healthyOutput = `${healthy.stdout || ""}\n${healthy.stderr || ""}`;
  if (healthy.status !== 0 || !healthyOutput.includes("ADDRESS table equality PASS: 4/4")
      || !healthyOutput.includes("ADDRESS rows PASS: 114/114")
      || !healthyOutput.includes("DIFFERENTIAL PASS: 36/36")) {
    throw new Error(`S5 address healthy control failed\n${healthyOutput}`);
  }
  console.log("S5 address healthy control PASS: equality, 114 rows, and 36 differential forms.");

  const multicastAnchor = '    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",';
  const multicastMutation = replaceOnce(
    source,
    multicastAnchor,
    '    "203.0.113.0/24", "240.0.0.0/4",',
    "remove-224-table-entry",
  );
  prove("remove-224-table-entry-equality", multicastMutation, "ADDRESS table ipv4NonPublic differs from pinned skills contract");
  const equalityBlock = testSource.slice(
    testSource.indexOf("// ADDRESS_TABLE_EQUALITY_START"),
    testSource.indexOf("// ADDRESS_TABLE_EQUALITY_END") + "// ADDRESS_TABLE_EQUALITY_END".length,
  );
  if (!equalityBlock.startsWith("// ADDRESS_TABLE_EQUALITY_START")
      || !equalityBlock.endsWith("// ADDRESS_TABLE_EQUALITY_END")) {
    throw new Error("remove-224-table-entry-row: equality block anchors were not found");
  }
  const rowOnlyTest = replaceOnce(
    testSource,
    equalityBlock,
    "// Equality deliberately removed only in this detector-of-detector copy.",
    "remove-224-table-entry-row-test-copy",
  );
  const rowOnlyTestPath = join(dir, "address-contract-row-only.mjs");
  writeFileSync(rowOnlyTestPath, rowOnlyTest);
  prove(
    "remove-224-table-entry-row",
    multicastMutation,
    "ADDRESS row ipv4-multicast-start: expected refuse/0 robots calls, got allow/1",
    rowOnlyTestPath,
  );

  prove(
    "remove-mapped-unwrap",
    replaceOnce(
      source,
      "    return isPublicIpv4(Number(ipv6 & 0xffffffffn));",
      "    return true; // S5 mapped-address unwrap removed",
      "remove-mapped-unwrap",
    ),
    "ADDRESS row mapped-loopback-compressed-dotted: expected refuse/0 robots calls, got allow/1",
  );

  prove(
    "ignore-ipv6-exclusions",
    replaceOnce(
      source,
      "    && !addressContract.ipv6NonPublicWithinPublic.some((cidr) => cidrContains(ipv6, cidr, parseIpv6Strict, 128));",
      "    && true; // S5 IPv6 exclusions ignored",
      "ignore-ipv6-exclusions",
    ),
    "ADDRESS row ipv6-special-2001-start: expected refuse/0 robots calls, got allow/1",
  );

  prove(
    "accept-leading-zero-ipv4",
    replaceOnce(
      source,
      '  if (octets.some((part) => (part.length > 1 && part.startsWith("0")) || Number(part) > 255)) return null;',
      "  if (octets.some((part) => Number(part) > 255)) return null;",
      "accept-leading-zero-ipv4",
    ),
    "DIFFERENTIAL 01.2.3.4: expected refuse/0 robots calls, got allow/1",
  );

  prove(
    "accept-zone-id",
    replaceOnce(
      source,
      'function parseIpv6Strict(text) {\n  if (!text || text.includes("%") || text.includes("/") || text.includes("[") || text.includes("]")) return null;',
      'function parseIpv6Strict(text) {\n  text = text.split("%")[0];\n  if (!text || text.includes("/") || text.includes("[") || text.includes("]")) return null;',
      "accept-zone-id",
    ),
    "DIFFERENTIAL 2606:4700::1111%eth0: expected refuse/0 robots calls, got allow/1",
  );
  console.log("S5 address canaries PASS: 6/6 named gates (five mutations; table removal proved twice)." );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
