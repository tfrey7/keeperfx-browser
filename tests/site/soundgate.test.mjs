// Whether the engine page waits for a click before starting (site/js/soundgate.js), run by
// `node --test` against a stand-in Web Audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { soundIsBlocked } from "../../site/js/soundgate.js";

// An audio context the browser either starts or holds back, as its autoplay policy decides.
function scopeWhere(allowed, { startsAt = "suspended" } = {}) {
  const made = [];
  class AudioContext {
    constructor() { this.state = allowed ? startsAt : "suspended"; made.push(this); }
    resume() {
      if (allowed) this.state = "running";
      return allowed ? Promise.resolve() : new Promise(() => {}); // Chrome never settles it
    }
    close() { this.closed = true; return Promise.resolve(); }
  }
  return { scope: { AudioContext }, made };
}

test("opened directly, a held-back context means waiting for a click", async () => {
  const { scope, made } = scopeWhere(false);
  assert.equal(await soundIsBlocked(scope, 5), true);
  assert.equal(made[0].closed, true); // the trial context is not left open
});

test("coming from the Start button, the sound is allowed and the engine starts at once", async () => {
  assert.equal(await soundIsBlocked(scopeWhere(true).scope, 5), false);
  assert.equal(await soundIsBlocked(scopeWhere(true, { startsAt: "running" }).scope, 5), false);
});

test("a browser that states its autoplay policy is taken at its word", async () => {
  const says = (policy) => ({ navigator: { getAutoplayPolicy: () => policy } });
  assert.equal(await soundIsBlocked(says("disallowed")), true);
  assert.equal(await soundIsBlocked(says("allowed-muted")), true);
  assert.equal(await soundIsBlocked(says("allowed")), false);
});

test("without Web Audio there is no sound to wait for", async () => {
  assert.equal(await soundIsBlocked({}), false);
});
