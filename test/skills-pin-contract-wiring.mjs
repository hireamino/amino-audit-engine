import { readFileSync } from "node:fs";

const verifyScript = process.env.VERIFY_SCRIPT || "scripts/verify.sh";
const source = readFileSync(verifyScript, "utf8");
const invocation = 'node "$ROOT/scripts/verify-skills-pin-contract.mjs"';
const count = source.split(invocation).length - 1;

if (count !== 1) {
  console.error(
    `FAIL WHI-221 verify wiring: expected exactly one self-proving skills-pin gate invocation, got ${count}`,
  );
  process.exit(1);
}

console.log("WHI-221 verify wiring PASS: self-proving skills-pin gate is invoked exactly once.");
