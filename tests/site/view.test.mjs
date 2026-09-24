// The engine page's scale-to-window sizing (site/js/view.js), run by `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSize } from "../../site/js/view.js";

test("a 640x480 game fills a wide window's height, keeping its shape", () => {
  assert.deepEqual(fitSize(1920, 1040, 640, 480), { width: 1386, height: 1040 });
});

test("a 640x480 game fills a tall window's width, keeping its shape", () => {
  assert.deepEqual(fitSize(800, 1200, 640, 480), { width: 800, height: 600 });
});

test("a small window shrinks the game rather than cropping it", () => {
  assert.deepEqual(fitSize(320, 400, 640, 480), { width: 320, height: 240 });
});

test("another engine resolution keeps its own shape", () => {
  assert.deepEqual(fitSize(1920, 1080, 1024, 768), { width: 1440, height: 1080 });
});

test("an unlaid-out stage leaves the engine's own size", () => {
  assert.deepEqual(fitSize(0, 0, 640, 480), { width: 640, height: 480 });
});
