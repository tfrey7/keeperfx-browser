// A limiter in front of the speakers, for the page's two audio contexts (OpenAL's, which carries
// the sound effects, and SDL's, which carries the music).
//
// On the desktop, OpenAL Soft limits its output, so a big fight's many overlapping effects stay
// below full scale. Emscripten's OpenAL sums every source into one gain node wired straight to the
// context's destination, so the same fight went over full scale and clipped (job 232: a peak of
// 1.285). Here every connection made to a context's destination is routed through a
// DynamicsCompressorNode set up as a limiter instead, without touching the engine.

// A hard knee, a steep ratio and a fast attack: a limiter, not a compressor that colours the mix.
export const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.15 };

// The Web Audio spec has the compressor add "makeup gain" to everything, quiet or loud: the
// full-range gain it takes off a 0 dB signal, raised to the power 0.6, back on. A trim after it
// takes that back off, so sound below the threshold (the music, a quiet level) passes unchanged.
export function makeupTrim({ threshold, ratio } = LIMITER) {
  const fullRangeDb = threshold - threshold / ratio; // what a 0 dB input comes out at
  return 10 ** ((0.6 * fullRangeDb) / 20);
}

export function limitOutput(scope = globalThis) {
  const { AudioNode, AudioDestinationNode } = scope;
  if (!AudioNode || !AudioDestinationNode || AudioNode.prototype.connect.kfxLimited) return;
  const connect = AudioNode.prototype.connect;
  const limiters = new WeakMap(); // audio context -> its limiter's input

  function limiterFor(destination) {
    const ctx = destination.context;
    let limiter = limiters.get(ctx);
    if (!limiter) {
      limiter = ctx.createDynamicsCompressor();
      for (const [name, value] of Object.entries(LIMITER)) limiter[name].value = value;
      const trim = ctx.createGain();
      trim.gain.value = makeupTrim();
      connect.call(limiter, trim);
      connect.call(trim, destination);
      limiters.set(ctx, limiter);
    }
    return limiter;
  }

  function limitedConnect(target, ...rest) {
    if (target instanceof AudioDestinationNode) target = limiterFor(target);
    return connect.call(this, target, ...rest);
  }
  limitedConnect.kfxLimited = true;
  AudioNode.prototype.connect = limitedConnect;
}
