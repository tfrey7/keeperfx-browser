// The page's output limiter (site/js/limiter.js), run by `node --test` against a stand-in Web Audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITER, limitOutput, makeupTrim } from "../../site/js/limiter.js";

// Just enough of Web Audio to see what connects to what.
function fakeAudio() {
  class AudioNode {
    constructor(context, kind) { Object.assign(this, { context, kind, outputs: [] }); }
    connect(target) { this.outputs.push(target); return target; }
  }
  class AudioDestinationNode extends AudioNode {}
  const param = () => ({ value: 0 });
  class AudioContext {
    constructor() { this.destination = new AudioDestinationNode(this, "destination"); }
    createGain() { return Object.assign(new AudioNode(this, "gain"), { gain: param() }); }
    createDynamicsCompressor() {
      const node = new AudioNode(this, "compressor");
      for (const name of Object.keys(LIMITER)) node[name] = param();
      return node;
    }
  }
  return { AudioNode, AudioDestinationNode, AudioContext };
}

test("whatever connects to the speakers goes through one limiter per context", () => {
  const scope = fakeAudio();
  limitOutput(scope);
  limitOutput(scope); // twice does not stack a second limiter
  const effects = new scope.AudioContext();
  const music = new scope.AudioContext();
  const a = effects.createGain();
  const b = effects.createGain();
  a.connect(effects.destination);
  b.connect(effects.destination);
  music.createGain().connect(music.destination);

  const [limiter] = a.outputs;
  assert.equal(limiter.kind, "compressor");
  assert.equal(b.outputs[0], limiter);
  assert.equal(limiter.threshold.value, LIMITER.threshold);
  assert.equal(limiter.ratio.value, LIMITER.ratio);
  const [trim] = limiter.outputs;
  assert.equal(trim.kind, "gain");
  assert.deepEqual(trim.outputs, [effects.destination]);
  assert.notEqual(music.destination.context, effects.destination.context);
  assert.notEqual(music.createGain().connect(music.destination), limiter);
});

test("connections that are not to the speakers are left alone", () => {
  const scope = fakeAudio();
  limitOutput(scope);
  const ctx = new scope.AudioContext();
  const source = ctx.createGain();
  const gain = ctx.createGain();
  source.connect(gain);
  assert.deepEqual(source.outputs, [gain]);
});

test("the trim takes the compressor's makeup gain back off", () => {
  // threshold -3 dB at 20:1 leaves a 0 dB input at -2.85 dB; makeup is 0.6 of that, 1.71 dB.
  assert.ok(Math.abs(makeupTrim({ threshold: -3, ratio: 20 }) - 10 ** (-1.71 / 20)) < 1e-9);
  assert.ok(makeupTrim() < 1);
});
