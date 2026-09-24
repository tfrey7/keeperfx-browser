// The page's frame-rate readout (engine.html?fps): how many frames the engine presents a second,
// and how many the browser shows (requestAnimationFrame), measured over each second.
//
// The engine draws each frame into its own 8-bit screen, converts it to RGBA and hands it to
// SDL's WebGL renderer, which clears the canvas once per present (RendererSoftware::PresentFrame).
// So counting the WebGL context's clear() calls counts the engine's frames, without touching the
// engine. The readout is off unless the page's address asks for it; the counters always run, so
// a proof driver can read window.kfxFps() either way.

export function countFrames(canvas, now = () => performance.now()) {
  const counts = { presents: 0, shown: 0 };
  const getContext = canvas.getContext.bind(canvas);
  canvas.getContext = (kind, ...rest) => {
    const gl = getContext(kind, ...rest);
    if (gl && /webgl/.test(kind) && !gl.kfxCounted) {
      const clear = gl.clear.bind(gl);
      gl.clear = (mask) => { counts.presents++; clear(mask); };
      gl.kfxCounted = true;
    }
    return gl;
  };
  let last = { t: now(), presents: 0, shown: 0 };
  // Frames per second since the last call to rate().
  const rate = () => {
    const t = now();
    const seconds = Math.max((t - last.t) / 1000, 1e-3);
    const out = {
      engine: +((counts.presents - last.presents) / seconds).toFixed(1),
      shown: +((counts.shown - last.shown) / seconds).toFixed(1),
    };
    last = { t, ...counts };
    return out;
  };
  return { counts, rate };
}

export function startReadout(canvas, show) {
  const { counts, rate } = countFrames(canvas);
  const tick = () => { counts.shown++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.kfxFps = () => ({ ...counts });
  if (!show) return;
  const box = document.createElement("p");
  box.className = "fps";
  box.id = "fps";
  canvas.insertAdjacentElement("beforebegin", box);
  setInterval(() => {
    const r = rate();
    box.textContent = `engine ${r.engine} fps · browser ${r.shown} fps`;
  }, 1000);
}
