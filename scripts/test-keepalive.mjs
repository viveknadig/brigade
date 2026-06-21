// scripts/test-keepalive.mjs — holds the event loop open for the duration of
// the test run, then releases it so the process exits normally.
//
// Why: Brigade's production timers are unref()'d on purpose — a pending
// approval, an idle-stream watchdog, a debounced file-watcher, a reconnect
// backoff, etc. must NEVER keep the gateway process alive. Many unit tests
// AWAIT the behaviour those timers drive (e.g. "approval times out after
// 30ms", "idle stream trips"). With only unref()'d handles left, Node's test
// runner can decide the event loop has drained BEFORE such a timer fires and
// cancel the still-pending test — which on Node 22.12 cascades
// `cancelledByParent` ("Promise resolution is still pending but the event loop
// has already resolved") across dozens of sibling tests. Node 24 happened to
// schedule differently and passed, masking the latent fragility.
//
// A single ref()'d interval keeps the loop alive while tests run; a top-level
// `after()` clears it once every test has settled, so the process still exits
// cleanly. This is test-only — production timer behaviour is unchanged.
import { after } from "node:test";

const keepAlive = setInterval(() => {}, 1 << 30); // ref()'d by default
after(() => clearInterval(keepAlive));
