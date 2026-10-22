import { pathToFileURL } from "node:url";

const enginePath = process.env.ENGINE || "src/engine.mjs";
const engine = await import(`${pathToFileURL(enginePath).href}?contract18=${Date.now()}`);

const checks = [
  [engine.contractVersion === "1.10.0", `contractVersion ${engine.contractVersion}`],
  [engine.registrableDomain(`${"a".repeat(64)}.com`) === null, "64-octet label is rejected"],
  [engine.registrableDomain("0x7f.1") === "0x7f.1", "IPv4 numeric shortcut is preserved as DNS labels"],
  [engine.registrableDomain("ex ample.com") === null, "whitespace is rejected"],
  [engine.registrableDomain("xn--.com") === null, "bare punycode marker is rejected"],
  [engine.registrableDomain("食狮。公司.cn") === null, "alternate Unicode separator is rejected"],
  [engine.registrableDomain("www.example.com") === "example.com", "ordinary registrable root is preserved"],
];

let failed = false;
for (const [ok, label] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} WHI-254 ${label}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log(`WHI-254 normalization contract PASS: ${checks.length}/${checks.length}`);
