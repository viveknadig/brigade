import assert from "node:assert/strict";
import { test } from "node:test";

import {
	UPDATE_CHECK_OPT_OUT_ENV,
	UPDATE_CHECK_TTL_MS,
	checkForUpdate,
	isNewerVersion,
	parseSemver,
} from "./update-check.js";

const PKG = { name: "@spinabot/brigade", version: "1.26.0", root: "/opt/global" };
const notSource = () => false;

/** Deps that never touch the network, the clock, or the disk. */
function deps(over: Parameters<typeof checkForUpdate>[0] = {}) {
	return {
		env: {} as NodeJS.ProcessEnv,
		now: () => 1_000_000,
		packageInfo: PKG,
		isSourceCheckout: notSource,
		readCache: () => undefined,
		writeCache: () => {},
		fetchLatest: async () => undefined,
		...over,
	};
}

/* ───────────────────────────── semver ───────────────────────────── */

test("parseSemver accepts the shapes npm actually publishes", () => {
	assert.deepEqual(parseSemver("1.26.1"), { major: 1, minor: 26, patch: 1, pre: false });
	assert.deepEqual(parseSemver("v1.26.1"), { major: 1, minor: 26, patch: 1, pre: false });
	assert.equal(parseSemver("1.27.0-rc.1")?.pre, true);
	assert.equal(parseSemver("1.26.1+build.5")?.pre, false);
	for (const bad of ["", "latest", "1.26", "1.26.x", undefined]) {
		assert.equal(parseSemver(bad as string), undefined, `must reject ${String(bad)}`);
	}
});

test("isNewerVersion compares numerically, not lexically", () => {
	assert.ok(isNewerVersion("1.26.10", "1.26.9"), "10 > 9 — a string compare gets this wrong");
	assert.ok(isNewerVersion("1.10.0", "1.9.0"));
	assert.ok(isNewerVersion("2.0.0", "1.99.99"));
	assert.equal(isNewerVersion("1.26.0", "1.26.0"), false);
	assert.equal(isNewerVersion("1.25.3", "1.26.0"), false, "never offer a downgrade");
});

test("isNewerVersion never pushes an operator onto a prerelease", () => {
	assert.equal(isNewerVersion("1.27.0-rc.1", "1.26.0"), false);
	// …but it will carry them OFF one, onto the matching release.
	assert.ok(isNewerVersion("1.27.0", "1.27.0-rc.1"));
});

test("isNewerVersion treats anything unparseable as 'no update'", () => {
	assert.equal(isNewerVersion(undefined, "1.26.0"), false);
	assert.equal(isNewerVersion("garbage", "1.26.0"), false);
	assert.equal(isNewerVersion("1.27.0", "dev"), false);
});

/* ───────────────────────────── the check ───────────────────────────── */

test("reports an update when the registry has a newer release", async () => {
	const got = await checkForUpdate(deps({ fetchLatest: async () => "1.26.1" }));
	assert.deepEqual(got, { current: "1.26.0", latest: "1.26.1" });
});

test("says nothing when already current", async () => {
	assert.equal(await checkForUpdate(deps({ fetchLatest: async () => "1.26.0" })), undefined);
});

test("a source checkout is never nagged — it updates with git, not npm", async () => {
	let asked = false;
	const got = await checkForUpdate(
		deps({
			isSourceCheckout: () => true,
			fetchLatest: async () => {
				asked = true;
				return "9.9.9";
			},
		}),
	);
	assert.equal(got, undefined);
	assert.equal(asked, false, "and we don't even ask the registry");
});

test("the opt-out env var disables the check entirely", async () => {
	for (const val of ["1", "true", "yes"]) {
		const got = await checkForUpdate(
			deps({ env: { [UPDATE_CHECK_OPT_OUT_ENV]: val }, fetchLatest: async () => "9.9.9" }),
		);
		assert.equal(got, undefined, `opt-out=${val}`);
	}
	// …but an explicit falsey value leaves it on.
	const on = await checkForUpdate(deps({ env: { [UPDATE_CHECK_OPT_OUT_ENV]: "0" }, fetchLatest: async () => "1.26.1" }));
	assert.deepEqual(on, { current: "1.26.0", latest: "1.26.1" });
});

test("an unreachable registry is silent, never an error", async () => {
	const offline = await checkForUpdate(deps({ fetchLatest: async () => undefined }));
	assert.equal(offline, undefined);

	// Even a fetcher that throws must not escape: this runs on gateway boot.
	const thrown = await checkForUpdate(
		deps({
			fetchLatest: async () => {
				throw new Error("EAI_AGAIN registry.npmjs.org");
			},
		}),
	);
	assert.equal(thrown, undefined);
});

test("a failed lookup is NOT cached — it would silence the next six hours", async () => {
	const writes: unknown[] = [];
	await checkForUpdate(deps({ fetchLatest: async () => undefined, writeCache: (c) => writes.push(c) }));
	assert.deepEqual(writes, []);
});

test("a fresh cache answers without touching the network", async () => {
	let asked = 0;
	const got = await checkForUpdate(
		deps({
			now: () => 1_000_000,
			readCache: () => ({ checkedAt: 1_000_000 - 1000, latest: "1.26.1" }),
			fetchLatest: async () => {
				asked++;
				return "9.9.9";
			},
		}),
	);
	assert.deepEqual(got, { current: "1.26.0", latest: "1.26.1" }, "served from cache");
	assert.equal(asked, 0, "a gateway restarted twenty times asks the registry once");
});

test("a stale cache is refreshed", async () => {
	const writes: { checkedAt: number; latest: string }[] = [];
	const now = 1_000_000 + UPDATE_CHECK_TTL_MS + 1;
	const got = await checkForUpdate(
		deps({
			now: () => now,
			readCache: () => ({ checkedAt: 1_000_000, latest: "1.26.0" }),
			fetchLatest: async () => "1.27.0",
			writeCache: (c) => writes.push(c),
		}),
	);
	assert.deepEqual(got, { current: "1.26.0", latest: "1.27.0" });
	assert.deepEqual(writes, [{ checkedAt: now, latest: "1.27.0" }]);
});

test("a corrupt cache behaves as a cold one", async () => {
	const got = await checkForUpdate(
		deps({
			readCache: () => undefined, // what defaultReadCache returns on bad JSON
			fetchLatest: async () => "1.26.1",
		}),
	);
	assert.deepEqual(got, { current: "1.26.0", latest: "1.26.1" });
});

test("an unidentifiable build reports nothing rather than guessing", async () => {
	// `resolvePackageInfo()` yields 0.0.0 when it cannot find a package.json. We do not
	// know what that build is, so we are in no position to call it outdated.
	for (const version of ["0.0.0", "0.0.0-dev", "not-a-version"]) {
		const got = await checkForUpdate(deps({ packageInfo: { ...PKG, version }, fetchLatest: async () => "1.26.1" }));
		assert.equal(got, undefined, `version=${version}`);
	}
	// A real 0.x release is still a real version and DOES get told.
	const real = await checkForUpdate(deps({ packageInfo: { ...PKG, version: "0.1.0" }, fetchLatest: async () => "0.2.0" }));
	assert.deepEqual(real, { current: "0.1.0", latest: "0.2.0" });
});
