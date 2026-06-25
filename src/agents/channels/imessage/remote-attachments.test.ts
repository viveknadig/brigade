/**
 * iMessage remote-host attachment fetch (Fix 4).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	detectRemoteHostFromCliPath,
	normalizeScpRemoteHost,
	scpCopyRemoteAttachment,
} from "./remote-attachments.js";

describe("normalizeScpRemoteHost", () => {
	it("accepts a bare host + a user@host", () => {
		assert.equal(normalizeScpRemoteHost("mac-mini"), "mac-mini");
		assert.equal(normalizeScpRemoteHost("brigade@192.168.64.3"), "brigade@192.168.64.3");
		assert.equal(normalizeScpRemoteHost("  mac.local  "), "mac.local");
	});

	it("rejects injection-shaped / malformed hosts", () => {
		assert.equal(normalizeScpRemoteHost(""), undefined);
		assert.equal(normalizeScpRemoteHost(undefined), undefined);
		assert.equal(normalizeScpRemoteHost("-oProxyCommand=evil"), undefined); // leading dash
		assert.equal(normalizeScpRemoteHost("host with space"), undefined);
		assert.equal(normalizeScpRemoteHost("a/b"), undefined); // path separator
		assert.equal(normalizeScpRemoteHost("a@b@c"), undefined); // double @
		assert.equal(normalizeScpRemoteHost("@host"), undefined); // empty user
		assert.equal(normalizeScpRemoteHost("host:1234"), undefined); // bare port (not bracketed v6)
	});

	it("accepts a bracketed IPv6 host", () => {
		assert.equal(normalizeScpRemoteHost("[fe80::1]"), "[fe80::1]");
	});
});

describe("detectRemoteHostFromCliPath", () => {
	it("detects user@host from an ssh wrapper script", async () => {
		const script = '#!/bin/sh\nexec ssh -T brigade@192.168.64.3 /opt/homebrew/bin/imsg "$@"\n';
		const host = await detectRemoteHostFromCliPath("/usr/local/bin/imsg-remote", async () => script);
		assert.equal(host, "brigade@192.168.64.3");
	});

	it("detects a bare host before the imsg command", async () => {
		const script = '#!/bin/sh\nexec ssh -T mac-mini imsg "$@"\n';
		const host = await detectRemoteHostFromCliPath("/usr/local/bin/imsg-remote", async () => script);
		assert.equal(host, "mac-mini");
	});

	it("returns undefined when the file is unreadable", async () => {
		const host = await detectRemoteHostFromCliPath("/nope", async () => {
			throw new Error("ENOENT");
		});
		assert.equal(host, undefined);
	});

	it("returns undefined for a non-ssh script", async () => {
		const host = await detectRemoteHostFromCliPath("/bin/imsg", async () => "#!/bin/sh\nexec imsg \"$@\"\n");
		assert.equal(host, undefined);
	});
});

describe("scpCopyRemoteAttachment", () => {
	it("copies via the injected scp runner and returns a local path", async () => {
		const calls: Array<{ remoteHost: string; remotePath: string; localPath: string }> = [];
		const local = await scpCopyRemoteAttachment({
			remoteHost: "brigade@mac",
			remotePath: "/Users/me/Library/Messages/Attachments/x/y/photo.jpg",
			mkdtempImpl: async () => "/tmp/brigade-imsg-AAAA",
			scpRunner: async (a) => {
				calls.push(a);
			},
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.remoteHost, "brigade@mac");
		assert.equal(calls[0]?.remotePath, "/Users/me/Library/Messages/Attachments/x/y/photo.jpg");
		// Local path is under the temp dir + keeps the basename.
		assert.ok(local.replace(/\\/g, "/").startsWith("/tmp/brigade-imsg-AAAA/"));
		assert.ok(local.endsWith("photo.jpg"));
		assert.equal(calls[0]?.localPath, local);
	});

	it("propagates an scp failure", async () => {
		await assert.rejects(
			() =>
				scpCopyRemoteAttachment({
					remoteHost: "brigade@mac",
					remotePath: "/x/y.jpg",
					mkdtempImpl: async () => "/tmp/brigade-imsg-BBBB",
					scpRunner: async () => {
						throw new Error("scp exited (code 1)");
					},
				}),
			/scp exited/,
		);
	});
});
