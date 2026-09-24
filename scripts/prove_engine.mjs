// Proves the engine boots in a real headless Chrome, against the page as served: engine.html
// loads keeperfx.js + keeperfx.wasm, calls main(), and the engine's own startup log appears in
// the page's console. It may then stop for want of game files; that is expected. Writes the
// page console to <shots>/engine-console.txt and a screenshot to <shots>/engine-boot.png.
//
//   py -3.10 scripts/serve.py --port 8810          (in another terminal)
//   node scripts/prove_engine.mjs --url http://localhost:8810/engine.html --work <scratch dir> --shots docs/proof
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Browser } from "./cdp.mjs";

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}
const url = arg("--url", "http://localhost:8810/engine.html");
const work = path.resolve(arg("--work", "proof-work"));
const shots = path.resolve(arg("--shots", "docs/proof"));
const debugPort = Number(arg("--debug-port", "8811"));

mkdirSync(shots, { recursive: true });
const browser = await Browser.launch({ profile: path.join(work, "engine-profile"), port: debugPort });
let failed = false;
try {
  await browser.goto(url);
  // The engine's own log lines are mirrored to the console with this prefix.
  const fromEngine = () => browser.console.filter((l) => l.startsWith("[keeperfx.log]"));
  const end = Date.now() + 60000;
  while (Date.now() < end && fromEngine().length === 0) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 3000)); // let it get as far as it will
  await browser.screenshot(path.join(shots, "engine-boot.png"));
  writeFileSync(path.join(shots, "engine-console.txt"), browser.console.join("\n") + "\n");
  if (fromEngine().length === 0) {
    failed = true;
    console.error(`no engine log in the page console:\n${browser.console.join("\n")}`);
  } else {
    console.log(`engine logged ${fromEngine().length} line(s) in the page console:`);
    console.log(fromEngine().slice(0, 25).join("\n"));
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
