// A small driver for a real headless Chrome over the DevTools protocol, with no dependencies
// (Node 22+ has WebSocket built in). Used by prove_files.mjs to drive the served page.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const CHROMES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Browser {
  // profile: a folder of our own, so storage survives between pages (and runs if kept).
  static async launch({ profile, port, width = 1100, height = 1000 }) {
    const exe = CHROMES.find((p) => p && existsSync(p));
    if (!exe) throw new Error("no Chrome or Edge found; set CHROME");
    mkdirSync(profile, { recursive: true });
    const proc = spawn(exe, [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`, "--no-first-run", "--no-default-browser-check",
      // Extra Chrome flags, each starting --, e.g. --host-resolver-rules to reach a live site
      // whose name a local DNS cache still refuses.
      ...(process.env.CHROME_FLAGS || "").split(/\s+(?=--)/).filter(Boolean), "about:blank",
    ], { stdio: "ignore" });
    const b = new Browser(proc, port);
    await b.#connect();
    await b.send("Page.enable");
    await b.send("Runtime.enable");
    await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    return b;
  }

  constructor(proc, port) {
    this.proc = proc;
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.handlers = {};
    this.console = [];
  }

  // Calls fn with every event of this method, e.g. "Fetch.requestPaused".
  on(method, fn) {
    this.handlers[method] = fn;
  }

  async #connect() {
    let pages;
    for (let i = 0; i < 100; i++) {
      try {
        pages = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        if (pages.some((p) => p.type === "page")) break;
      } catch { /* not up yet */ }
      await sleep(100);
    }
    const page = pages?.find((p) => p.type === "page");
    if (!page) throw new Error("Chrome did not open a page");
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) {
        if (msg.method === "Runtime.consoleAPICalled") {
          this.console.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
        }
        this.waiters = this.waiters.filter((w) => !(w.method === msg.method && (w.ok(msg.params), true)));
        this.handlers[msg.method]?.(msg.params);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }

  once(method) {
    return new Promise((ok) => this.waiters.push({ method, ok }));
  }

  async goto(url) {
    const loaded = this.once("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  // Waits until the expression is truthy in the page, or fails saying what it waited for.
  async waitFor(expression, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.eval(expression)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for: ${expression}\npage console:\n${this.console.join("\n")}`);
  }

  // Hands files (or, for a webkitdirectory input, a folder) to a file input, as a person would.
  async setFiles(selector, files) {
    const { root } = await this.send("DOM.getDocument");
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    await this.send("DOM.setFileInputFiles", { nodeId, files });
  }

  async click(selector) {
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }

  async screenshot(path) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(path, Buffer.from(data, "base64"));
  }

  async close() {
    try { await this.send("Browser.close"); } catch { /* already gone */ }
    this.ws?.close();
    await sleep(300);
    if (this.proc.exitCode === null) this.proc.kill();
  }
}
