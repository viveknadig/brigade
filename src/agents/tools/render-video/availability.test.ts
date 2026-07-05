import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import {
	__resetRenderVideoAvailabilityCache,
	isRenderVideoAvailable,
	renderVideoDoctor,
	whichOnPath,
} from "./availability.js";

test("whichOnPath: resolves an explicit existing path, null for a missing command", () => {
	// process.execPath is an absolute path to a real executable (the running node).
	assert.ok(whichOnPath(process.execPath), "should resolve an explicit existing path");
	assert.equal(whichOnPath("brigade-definitely-not-a-real-binary-xyz"), null);
});

test("renderVideoDoctor: well-formed rollup; node ok on a 22+ runtime", () => {
	const d = renderVideoDoctor();
	for (const dep of [d.node, d.ffmpeg, d.chrome, d.hyperframes]) {
		assert.equal(typeof dep.ok, "boolean");
		assert.equal(typeof dep.detail, "string");
		assert.ok(dep.detail.length > 0);
	}
	// The test runner itself is Node 22+.
	assert.equal(d.node.ok, true);
	assert.equal(typeof d.ready, "boolean");
});

test("renderVideoDoctor: a bad engine override is reported, and blocks `ready`", () => {
	const prev = process.env.BRIGADE_HYPERFRAMES_PATH;
	process.env.BRIGADE_HYPERFRAMES_PATH = "/nope/producer-does-not-exist";
	try {
		const d = renderVideoDoctor();
		assert.equal(d.hyperframes.ok, false);
		assert.match(d.hyperframes.detail, /BRIGADE_HYPERFRAMES_PATH/); // names the bad override
		assert.equal(d.ready, false); // engine missing ⇒ not ready
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_HYPERFRAMES_PATH;
		else process.env.BRIGADE_HYPERFRAMES_PATH = prev;
	}
});

test("isRenderVideoAvailable: caches within TTL, force bypasses, TTL expiry re-checks", () => {
	__resetRenderVideoAvailabilityCache();
	const prev = process.env.BRIGADE_HYPERFRAMES_PATH;
	process.env.BRIGADE_HYPERFRAMES_PATH = "/nope/hyperframes-does-not-exist";
	try {
		assert.equal(isRenderVideoAvailable({ nowMs: 1000 }), false); // no engine → unavailable
		// Even if the env "changed", a cached read within the TTL returns the cache.
		process.env.BRIGADE_HYPERFRAMES_PATH = process.execPath; // now "resolvable"
		assert.equal(isRenderVideoAvailable({ nowMs: 1500 }), false, "cached within TTL");
		assert.equal(isRenderVideoAvailable({ force: true, nowMs: 1600 }), true, "force re-checks");
		// Past the 60s TTL a non-force call must re-check, not serve the stale value.
		process.env.BRIGADE_HYPERFRAMES_PATH = "/nope/gone-again";
		assert.equal(isRenderVideoAvailable({ nowMs: 1600 + 60_001 }), false, "TTL expiry re-checks");
	} finally {
		__resetRenderVideoAvailabilityCache();
		if (prev === undefined) delete process.env.BRIGADE_HYPERFRAMES_PATH;
		else process.env.BRIGADE_HYPERFRAMES_PATH = prev;
	}
});

test("whichOnPath: resolves a bare command via a PATH scan", () => {
	const prev = process.env.PATH;
	// Put the running node's own directory on PATH and resolve its basename.
	process.env.PATH = path.dirname(process.execPath);
	try {
		const bare = path.basename(process.execPath).replace(/\.exe$/i, "");
		assert.ok(whichOnPath(bare), "bare command resolves through the PATH scan");
	} finally {
		if (prev === undefined) delete process.env.PATH;
		else process.env.PATH = prev;
	}
});

test("checkFfmpeg: FFMPEG_PATH override — resolves, and names itself when bad", () => {
	const prev = process.env.FFMPEG_PATH;
	try {
		process.env.FFMPEG_PATH = process.execPath;
		assert.equal(renderVideoDoctor().ffmpeg.ok, true);
		process.env.FFMPEG_PATH = "/nope/ffmpeg-missing";
		const d = renderVideoDoctor().ffmpeg;
		assert.equal(d.ok, false);
		assert.match(d.detail, /FFMPEG_PATH/); // actionable: tells the operator the override is bad
	} finally {
		if (prev === undefined) delete process.env.FFMPEG_PATH;
		else process.env.FFMPEG_PATH = prev;
	}
});

test("renderVideoDoctor: a missing Chrome is SOFT — it does not block `ready`", () => {
	const prevPath = process.env.PATH;
	const prevWinPath = process.env.Path;
	const prevFf = process.env.FFMPEG_PATH;
	const prevHf = process.env.BRIGADE_HYPERFRAMES_PATH;
	const prevPup = process.env.PUPPETEER_EXECUTABLE_PATH;
	const prevBrowser = process.env.BRIGADE_BROWSER_EXECUTABLE;
	try {
		// No PATH (so no chrome resolves) but ffmpeg + engine explicitly resolvable.
		process.env.PATH = "";
		process.env.Path = "";
		process.env.FFMPEG_PATH = process.execPath;
		process.env.BRIGADE_HYPERFRAMES_PATH = process.execPath;
		delete process.env.PUPPETEER_EXECUTABLE_PATH;
		delete process.env.BRIGADE_BROWSER_EXECUTABLE;
		const d = renderVideoDoctor();
		assert.equal(d.chrome.ok, false, "chrome not found");
		assert.equal(d.ready, true, "chrome is a soft gap — hard deps present ⇒ ready");
	} finally {
		const restore = (k: string, v: string | undefined): void => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		restore("PATH", prevPath);
		restore("Path", prevWinPath);
		restore("FFMPEG_PATH", prevFf);
		restore("BRIGADE_HYPERFRAMES_PATH", prevHf);
		restore("PUPPETEER_EXECUTABLE_PATH", prevPup);
		restore("BRIGADE_BROWSER_EXECUTABLE", prevBrowser);
	}
});
