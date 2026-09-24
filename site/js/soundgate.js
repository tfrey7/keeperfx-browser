// Holds the engine back until a click when the browser would start it without sound.
//
// Browsers keep a page's audio off until the player has clicked or pressed a key on it. Coming
// from the files page's Start button counts; opening the game page directly (a bookmark, a new
// tab) does not, and then the whole intro movie played in silence, and the click that finally
// turned the sound on also skipped the movie. So when the sound would be held back, the page asks
// for a click first and only then starts the engine: the intro plays from its start, with sound.

// How long a trial audio context gets to start before the sound counts as held back.
export const PROBE_MS = 300;

// Whether the browser would keep a new audio context silent until the player clicks.
export async function soundIsBlocked(scope = globalThis, probeMs = PROBE_MS) {
  // Firefox says so outright.
  const policy = scope.navigator?.getAutoplayPolicy?.("audiocontext");
  if (policy) return policy !== "allowed";
  // Elsewhere, try one: a context the browser holds back stays suspended.
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Context) return false; // no Web Audio: nothing to wait for
  const probe = new Context();
  try {
    if (probe.state !== "running") {
      await Promise.race([
        probe.resume().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, probeMs)),
      ]);
    }
    return probe.state !== "running";
  } finally {
    probe.close?.().catch?.(() => {});
  }
}

// Shows the "click to play" panel and resolves once the player has clicked it or pressed a key.
// A whole click, not just the press, so its release does not reach the engine's canvas; not
// Escape, which browsers do not count as the player asking for sound.
export function waitForClick({ panel, button }) {
  panel.hidden = false;
  button.focus();
  return new Promise((resolve) => {
    const go = (event) => {
      if (event.type === "keydown" && event.key === "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      panel.removeEventListener("click", go);
      document.removeEventListener("keydown", go, true);
      panel.hidden = true;
      resolve();
    };
    panel.addEventListener("click", go);
    document.addEventListener("keydown", go, true);
  });
}
