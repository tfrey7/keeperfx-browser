// How the proof scripts' Chrome driver skips the intro movie to the main menu
// (Browser.skipIntro in scripts/cdp.mjs), run by `node --test` against a stand-in page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser } from "../../scripts/cdp.mjs";

// A page whose intro gives way to the main menu after `escapes` presses of Escape.
function page(escapes) {
  const p = { escaped: 0 };
  p.eval = async (expr) => {
    if (expr.includes("FeSt_MAIN_MENU")) return p.escaped >= escapes;
    throw new Error(`unexpected: ${expr}`);
  };
  p.send = async (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp" && params.key === "Escape") p.escaped++;
  };
  return p;
}
const skipIntro = (p, timeoutMs) => Browser.prototype.skipIntro.call(p, timeoutMs, { everyMs: 1 });

test("Escape is pressed until the intro gives way to the main menu, and no more", async () => {
  const p = page(3);
  assert.equal(await skipIntro(p, 1000), 3);
  assert.equal(p.escaped, 3);
});

test("with no intro, the main menu needs no Escape", async () => {
  assert.equal(await skipIntro(page(0), 1000), 0);
});

test("an intro that never ends is reported, not waited on for ever", async () => {
  await assert.rejects(skipIntro(page(Infinity), 20), /never reached its main menu/);
});
