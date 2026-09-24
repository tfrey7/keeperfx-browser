// The game's view on the engine page: the canvas scaled to fill the window (or the screen, in
// full screen) at the engine's own shape, a full-screen button, and the engine log in a drawer.
//
// The engine draws at its own resolution (640x480 for the menus), which is the canvas's width
// and height; only its CSS size is changed here. SDL scales the mouse by the canvas's CSS size,
// so the canvas box must be exactly the picture: no letterboxing inside it (object-fit), only
// around it. SDL may set the canvas's inline size itself, so the stylesheet applies ours with
// !important through --fit-w and --fit-h.

// The largest width and height of the engine's aspect that fits in the box, in whole CSS pixels.
export function fitSize(boxWidth, boxHeight, width, height) {
  if (!(boxWidth > 0 && boxHeight > 0 && width > 0 && height > 0)) return { width, height };
  const scale = Math.min(boxWidth / width, boxHeight / height);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

export function setUpView({ stage, canvas, fullscreenButton, logButton, logPanel }) {
  const fit = () => {
    const { width, height } = fitSize(stage.clientWidth, stage.clientHeight, canvas.width, canvas.height);
    stage.style.setProperty("--fit-w", `${width}px`);
    stage.style.setProperty("--fit-h", `${height}px`);
  };
  new ResizeObserver(fit).observe(stage);
  // The engine changes its resolution by setting the canvas's width and height.
  new MutationObserver(fit).observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  fit();

  logButton.addEventListener("click", () => {
    const open = logPanel.hidden;
    logPanel.hidden = !open;
    logButton.setAttribute("aria-expanded", String(open));
    if (open) logPanel.querySelector("pre").scrollTop = 1e9;
  });

  if (!stage.requestFullscreen) {
    fullscreenButton.hidden = true;
    return;
  }
  fullscreenButton.addEventListener("click", () => {
    stage.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === stage) {
      // Escape opens the game's options, as on the desktop; where the browser allows it
      // (Chrome, Edge), holding Escape is what leaves full screen instead.
      navigator.keyboard?.lock?.(["Escape"]).catch(() => {});
    } else {
      navigator.keyboard?.unlock?.();
    }
    canvas.focus?.();
  });
}
