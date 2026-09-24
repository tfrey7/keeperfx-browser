// The engine page's scale-to-window sizing (site/js/view.js), run by `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { endedMessage, fitSize } from "../../site/js/view.js";

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

test("quitting the game is a normal end, told plainly", () => {
  assert.deepEqual(endedMessage(0), { text: "The game has closed.", kind: "" });
});

test("any other exit code is a failure that points at the log", () => {
  const { text, kind } = endedMessage(3);
  assert.equal(kind, "bad");
  assert.match(text, /exit code 3/);
});
