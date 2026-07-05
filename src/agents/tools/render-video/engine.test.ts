import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { RENDER_WORKER_SOURCE, buildWorkerArgs, runRender, writeRenderWorker, type RenderSpec } from "./engine.js";

const SPEC: RenderSpec = {
	producerEntry: "/pkg/producer/index.js",
	workerPath: "/tmp/wd/render-worker.mjs",
	inputPath: "/tmp/wd/index.html",
	outputPath: "/tmp/wd/out.mp4",
	width: 1080,
	height: 1920,
	fps: 30,
};

/* ─────────────────────────── worker + args ─────────────────────────── */

test("buildWorkerArgs passes producer entry + paths + dimensions positionally", () => {
	assert.deepEqual(buildWorkerArgs(SPEC), [
		"/tmp/wd/render-worker.mjs",
		"/pkg/producer/index.js",
		"/tmp/wd/index.html",
		"/tmp/wd/out.mp4",
		"1080",
		"1920",
		"30",
	]);
});

test("writeRenderWorker writes a syntactically-parseable ESM worker", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-worker-"));
	try {
		const p = writeRenderWorker(dir);
		assert.equal(path.basename(p), "render-worker.mjs");
		const src = fs.readFileSync(p, "utf8");
		assert.equal(src, RENDER_WORKER_SOURCE);
		assert.match(src, /createRenderJob/);
		assert.match(src, /executeRenderJob/);
		// It must parse as a module (no template-string escaping mistakes).
		assert.doesNotThrow(() => new Function(src.replace(/^import .*$/gm, "").replace(/await import/g, "Promise.resolve")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/* ─────────────────────────── controllable fake child ─────────────────────────── */

interface FakeOpts {
	emitCloseOnKill?: boolean;
}
function makeSpawn(opts: FakeOpts = {}) {
	const emitCloseOnKill = opts.emitCloseOnKill ?? true;
	const mkStream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
	const child = Object.assign(new EventEmitter(), {
		stdout: mkStream(),
		stderr: mkStream(),
		killed: false,
		kill(): void {
			child.killed = true;
			if (emitCloseOnKill) queueMicrotask(() => child.emit("close", null));
		},
	});
	const spawnFn = (() => child) as never;
	return { spawnFn, child };
}

/* ─────────────────────────── happy / error paths ─────────────────────────── */

test("runRender: success captures stdout + streams progress lines", async () => {
	const seen: string[] = [];
	const { spawnFn, child } = makeSpawn();
	const p = runRender(SPEC, { spawnFn, onProgress: (l) => seen.push(l) });
	child.stdout.emit("data", "progress rendering\nprogress encoding\n");
	child.emit("close", 0);
	const res = await p;
	assert.equal(res.code, 0);
	assert.equal(res.killReason, undefined);
	assert.deepEqual(seen, ["progress rendering", "progress encoding"]);
});

test("runRender: non-zero exit surfaces code + stderr (no throw, no kill)", async () => {
	const { spawnFn, child } = makeSpawn();
	const p = runRender(SPEC, { spawnFn });
	child.stderr.emit("data", "Error: bad composition");
	child.emit("close", 1);
	const res = await p;
	assert.equal(res.code, 1);
	assert.equal(res.killReason, undefined);
	assert.match(res.stderr, /bad composition/);
});

test("runRender: abort kills the child and reports killReason", async () => {
	const ac = new AbortController();
	ac.abort();
	const { spawnFn, child } = makeSpawn();
	const res = await runRender(SPEC, { spawnFn, signal: ac.signal });
	assert.equal(res.killReason, "aborted");
	assert.equal(res.code, null);
	assert.equal(child.killed, true);
});

test("runRender: synchronous spawn throw rejects", async () => {
	await assert.rejects(
		() => runRender(SPEC, { spawnFn: (() => { throw new Error("EACCES"); }) as never }),
		/EACCES/,
	);
});

test("runRender: async spawn error rejects (node missing)", async () => {
	const { spawnFn, child } = makeSpawn();
	const p = runRender(SPEC, { spawnFn });
	child.emit("error", new Error("spawn ENOENT"));
	await assert.rejects(() => p, /ENOENT/);
});

/* ─────────────────────────── watchdogs + force-settle (mock timers) ─────────────────────────── */

test("runRender: no-output watchdog kills a silent child", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { spawnFn, child } = makeSpawn();
	const p = runRender(SPEC, { spawnFn, noOutputTimeoutMs: 50, overallTimeoutMs: 10_000 });
	child.stdout.emit("data", "progress starting\n");
	t.mock.timers.tick(50);
	const res = await p;
	assert.equal(res.killReason, "no-output-timeout");
	assert.equal(child.killed, true);
});

test("runRender: output re-arms the no-output watchdog (does not trip early)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { spawnFn, child } = makeSpawn();
	const p = runRender(SPEC, { spawnFn, noOutputTimeoutMs: 50, overallTimeoutMs: 10_000 });
	t.mock.timers.tick(30);
	child.stdout.emit("data", "progress tick\n");
	t.mock.timers.tick(30);
	assert.equal(child.killed, false);
	child.emit("close", 0);
	assert.equal((await p).killReason, undefined);
});

test("runRender: overall watchdog kills even while output trickles", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { spawnFn, child } = makeSpawn();
	const p = runRender(SPEC, { spawnFn, noOutputTimeoutMs: 10_000, overallTimeoutMs: 100 });
	for (let i = 0; i < 3; i++) {
		t.mock.timers.tick(30);
		child.stdout.emit("data", `progress t${i}\n`);
	}
	t.mock.timers.tick(20);
	assert.equal((await p).killReason, "overall-timeout");
	assert.equal(child.killed, true);
});

test("runRender: force-settles if a killed child never emits close", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { spawnFn, child } = makeSpawn({ emitCloseOnKill: false });
	const ac = new AbortController();
	ac.abort();
	const p = runRender(SPEC, { spawnFn, signal: ac.signal });
	assert.equal(child.killed, true);
	t.mock.timers.tick(5_000);
	const res = await p;
	assert.equal(res.killReason, "aborted");
	assert.equal(res.code, null);
});

/* ─────────────────────────── progress line-buffering ─────────────────────────── */

test("runRender: reassembles progress lines split across chunks + flushes the last", async () => {
	const seen: string[] = [];
	const { spawnFn, child } = makeSpawn();
	const p = runRender(SPEC, { spawnFn, onProgress: (l) => seen.push(l) });
	child.stdout.emit("data", "progress frame 1/");
	child.stdout.emit("data", "10\nprogress frame 2/10\nprogress fra");
	child.stdout.emit("data", "me 3/10"); // final line, NO trailing newline
	child.emit("close", 0);
	await p;
	assert.deepEqual(seen, ["progress frame 1/10", "progress frame 2/10", "progress frame 3/10"]);
});

test("runRender: post-kill teardown 'error' honors the kill, does not reject", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { spawnFn, child } = makeSpawn({ emitCloseOnKill: false });
	const p = runRender(SPEC, { spawnFn, noOutputTimeoutMs: 50, overallTimeoutMs: 10_000 });
	child.stdout.emit("data", "progress starting\n");
	t.mock.timers.tick(50);
	child.emit("error", new Error("EPIPE during teardown"));
	const res = await p;
	assert.equal(res.killReason, "no-output-timeout");
	assert.equal(res.code, null);
});
