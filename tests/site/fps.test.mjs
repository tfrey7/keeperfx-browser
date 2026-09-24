// The page's frame-rate counter (site/js/fps.js), run by `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countFrames } from "../../site/js/fps.js";

function fakeCanvas() {
  const cleared = [];
  const gl = { clear: (mask) => cleared.push(mask) };
  return { cleared, canvas: { getContext: (kind) => (kind === "webgl2" ? gl : { clear() {} }) } };
}

test("each WebGL clear is one engine frame, and still clears", () => {
  const { canvas, cleared } = fakeCanvas();
  const { counts } = countFrames(canvas);
  const gl = canvas.getContext("webgl2");
  gl.clear(0x4000);
  gl.clear(0x4000);
  canvas.getContext("webgl2").clear(1); // the same context again is not counted twice
  assert.equal(counts.presents, 3);
  assert.deepEqual(cleared, [0x4000, 0x4000, 1]);
  canvas.getContext("2d").clear();
  assert.equal(counts.presents, 3);
});

test("rate() is frames per second since the last call", () => {
  const { canvas } = fakeCanvas();
  let t = 0;
  const { counts, rate } = countFrames(canvas, () => t);
  const gl = canvas.getContext("webgl2");
  for (let i = 0; i < 30; i++) gl.clear(1);
  counts.shown = 60;
  t = 500;
  assert.deepEqual(rate(), { engine: 60, shown: 120 });
  t = 1500;
  assert.deepEqual(rate(), { engine: 0, shown: 0 });
});
