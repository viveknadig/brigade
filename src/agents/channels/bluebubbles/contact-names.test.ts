import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
	buildContactIndex,
	clearBlueBubblesContactCache,
	contactLookupKey,
	normalizePhoneKey,
	resolveBlueBubblesContactName,
	type ResolveContactNameArgs,
} from "./contact-names.js";

const SERVER = "http://192.168.1.5:1234";
const PASSWORD = ["bb", "contact", "pw"].join("-");

/** A fake fetch returning a canned contact list + counting calls. */
function contactFetch(contacts: unknown[], counter: { calls: number }): typeof fetch {
	return (async () => {
		counter.calls++;
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 200, data: contacts }),
			headers: new Map<string, string>() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

function args(fetchImpl: typeof fetch, accountId = "default"): ResolveContactNameArgs {
	return { serverUrl: SERVER, password: PASSWORD, accountId, fetchImpl };
}

describe("normalizePhoneKey", () => {
	it("drops a leading US country code so +1 and bare collide", () => {
		assert.equal(normalizePhoneKey("+1 (555) 123-4567"), "5551234567");
		assert.equal(normalizePhoneKey("5551234567"), "5551234567");
	});
	it("returns null for too-short / non-numeric input", () => {
		assert.equal(normalizePhoneKey("12"), null);
		assert.equal(normalizePhoneKey("abc"), null);
	});
});

describe("contactLookupKey", () => {
	it("lowercases an email, digit-normalises a phone", () => {
		assert.equal(contactLookupKey("Alex@Example.COM"), "alex@example.com");
		assert.equal(contactLookupKey("+1-555-123-4567"), "5551234567");
	});
});

describe("buildContactIndex", () => {
	it("indexes phone + email to a display name", () => {
		const idx = buildContactIndex([
			{ displayName: "Alex Rivera", phoneNumbers: [{ address: "+15551234567" }], emails: [{ address: "alex@x.com" }] },
		]);
		assert.equal(idx.get("5551234567"), "Alex Rivera");
		assert.equal(idx.get("alex@x.com"), "Alex Rivera");
	});
	it("falls back to first+last when displayName is missing", () => {
		const idx = buildContactIndex([{ firstName: "Sam", lastName: "Lee", phoneNumbers: [{ address: "5559876543" }] }]);
		assert.equal(idx.get("5559876543"), "Sam Lee");
	});
});

describe("resolveBlueBubblesContactName", () => {
	beforeEach(() => clearBlueBubblesContactCache());

	it("resolves a phone sender to a display name", async () => {
		const counter = { calls: 0 };
		const f = contactFetch([{ displayName: "Alex Rivera", phoneNumbers: [{ address: "+15551234567" }] }], counter);
		const name = await resolveBlueBubblesContactName("+1 (555) 123-4567", args(f));
		assert.equal(name, "Alex Rivera");
		assert.equal(counter.calls, 1);
	});

	it("caches the directory — a second lookup does NOT re-fetch", async () => {
		const counter = { calls: 0 };
		const f = contactFetch(
			[
				{ displayName: "Alex Rivera", phoneNumbers: [{ address: "+15551234567" }] },
				{ displayName: "Sam Lee", emails: [{ address: "sam@x.com" }] },
			],
			counter,
		);
		const a = await resolveBlueBubblesContactName("5551234567", args(f), 1000);
		const b = await resolveBlueBubblesContactName("sam@x.com", args(f), 2000);
		assert.equal(a, "Alex Rivera");
		assert.equal(b, "Sam Lee");
		// One fetch served both lookups (directory cache hit).
		assert.equal(counter.calls, 1);
	});

	it("returns undefined for an unknown sender + does not re-query mid-TTL", async () => {
		const counter = { calls: 0 };
		const f = contactFetch([{ displayName: "Alex", phoneNumbers: [{ address: "+15550000000" }] }], counter);
		const miss1 = await resolveBlueBubblesContactName("+15559999999", args(f), 1000);
		const miss2 = await resolveBlueBubblesContactName("+15559999999", args(f), 2000);
		assert.equal(miss1, undefined);
		assert.equal(miss2, undefined);
		assert.equal(counter.calls, 1); // negative cache held; no re-fetch
	});

	it("returns undefined (never throws) on a transport failure", async () => {
		const f = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const name = await resolveBlueBubblesContactName("+15551234567", args(f));
		assert.equal(name, undefined);
	});

	it("re-fetches once the directory TTL expires", async () => {
		const counter = { calls: 0 };
		const f = contactFetch([{ displayName: "Alex", phoneNumbers: [{ address: "+15551234567" }] }], counter);
		await resolveBlueBubblesContactName("5551234567", args(f), 1000);
		// Far past the 1h TTL → a fresh fetch.
		await resolveBlueBubblesContactName("5551234567", args(f), 1000 + 2 * 60 * 60 * 1000);
		assert.equal(counter.calls, 2);
	});
});
