import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	addBlueBubblesParticipant,
	leaveBlueBubblesChat,
	markBlueBubblesChatRead,
	removeBlueBubblesParticipant,
	renameBlueBubblesChat,
	sendBlueBubblesTyping,
	setBlueBubblesGroupIcon,
} from "./chat.js";
import type { BlueBubblesRestBase } from "./send.js";

/** One recorded request the fake fetch saw. */
interface RecordedRequest {
	url: string;
	method: string;
	body: unknown;
	isForm: boolean;
}

/** A fake fetch recording each request + returning a canned 200 `{ data }` body. */
function recordingFetch(recorder: RecordedRequest[]): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		const body = init.body;
		let parsed: unknown = null;
		let isForm = false;
		if (typeof body === "string") {
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = body;
			}
		} else if (body instanceof FormData) {
			isForm = true;
			const obj: Record<string, unknown> = {};
			for (const [k, v] of (body as FormData).entries()) obj[k] = typeof v === "string" ? v : "(blob)";
			parsed = obj;
		}
		recorder.push({ url, method: (init.method ?? "GET").toUpperCase(), body: parsed, isForm });
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 200, data: {} }),
			headers: new Map<string, string>() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

const SERVER = "http://192.168.1.5:1234";
const PASSWORD = ["bb", "chat", "pw"].join("-");

function base(recorder: RecordedRequest[], privateApiEnabled?: boolean): BlueBubblesRestBase {
	return {
		serverUrl: SERVER,
		password: PASSWORD,
		fetchImpl: recordingFetch(recorder),
		...(privateApiEnabled !== undefined ? { privateApiEnabled } : {}),
	};
}

describe("BlueBubbles typing indicator", () => {
	it("POSTs to chat/{guid}/typing when turning typing ON", async () => {
		const rec: RecordedRequest[] = [];
		await sendBlueBubblesTyping(base(rec, true), { chatGuid: "iMessage;-;+1", typing: true });
		assert.equal(rec.length, 1);
		assert.equal(rec[0]!.method, "POST");
		assert.match(rec[0]!.url, /\/api\/v1\/chat\/iMessage%3B-%3B%2B1\/typing\?/);
	});

	it("DELETEs chat/{guid}/typing when turning typing OFF", async () => {
		const rec: RecordedRequest[] = [];
		await sendBlueBubblesTyping(base(rec, true), { chatGuid: "G", typing: false });
		assert.equal(rec.length, 1);
		assert.equal(rec[0]!.method, "DELETE");
	});

	it("silently no-ops (no request) when the Private API is OFF", async () => {
		const rec: RecordedRequest[] = [];
		await sendBlueBubblesTyping(base(rec, false), { chatGuid: "G", typing: true });
		assert.equal(rec.length, 0);
	});

	it("no-ops on an empty chatGuid", async () => {
		const rec: RecordedRequest[] = [];
		await sendBlueBubblesTyping(base(rec, true), { chatGuid: "   ", typing: true });
		assert.equal(rec.length, 0);
	});
});

describe("BlueBubbles mark-read", () => {
	it("POSTs to chat/{guid}/read", async () => {
		const rec: RecordedRequest[] = [];
		await markBlueBubblesChatRead(base(rec, true), { chatGuid: "G" });
		assert.equal(rec.length, 1);
		assert.equal(rec[0]!.method, "POST");
		assert.match(rec[0]!.url, /\/api\/v1\/chat\/G\/read\?/);
	});

	it("silently no-ops when the Private API is OFF", async () => {
		const rec: RecordedRequest[] = [];
		await markBlueBubblesChatRead(base(rec, false), { chatGuid: "G" });
		assert.equal(rec.length, 0);
	});
});

describe("BlueBubbles group admin", () => {
	it("rename-group PUTs chat/{guid} with displayName", async () => {
		const rec: RecordedRequest[] = [];
		await renameBlueBubblesChat(base(rec, true), { chatGuid: "G", displayName: "Team" });
		assert.equal(rec.length, 1);
		assert.equal(rec[0]!.method, "PUT");
		assert.match(rec[0]!.url, /\/api\/v1\/chat\/G\?/);
		assert.deepEqual(rec[0]!.body, { displayName: "Team" });
	});

	it("add-participant POSTs chat/{guid}/participant/add with the address", async () => {
		const rec: RecordedRequest[] = [];
		await addBlueBubblesParticipant(base(rec, true), { chatGuid: "G", address: "+15551234567" });
		assert.equal(rec.length, 1);
		assert.equal(rec[0]!.method, "POST");
		assert.match(rec[0]!.url, /\/participant\/add\?/);
		assert.deepEqual(rec[0]!.body, { address: "+15551234567" });
	});

	it("remove-participant POSTs chat/{guid}/participant/remove", async () => {
		const rec: RecordedRequest[] = [];
		await removeBlueBubblesParticipant(base(rec, true), { chatGuid: "G", address: "a@b.com" });
		assert.equal(rec.length, 1);
		assert.match(rec[0]!.url, /\/participant\/remove\?/);
		assert.deepEqual(rec[0]!.body, { address: "a@b.com" });
	});

	it("leave-group POSTs chat/{guid}/leave", async () => {
		const rec: RecordedRequest[] = [];
		await leaveBlueBubblesChat(base(rec, true), { chatGuid: "G" });
		assert.equal(rec.length, 1);
		assert.match(rec[0]!.url, /\/api\/v1\/chat\/G\/leave\?/);
	});

	it("set-group-icon POSTs a multipart form to chat/{guid}/icon", async () => {
		const rec: RecordedRequest[] = [];
		await setBlueBubblesGroupIcon(base(rec, true), { chatGuid: "G", bytes: new Uint8Array([1, 2, 3]) });
		assert.equal(rec.length, 1);
		assert.equal(rec[0]!.isForm, true);
		assert.match(rec[0]!.url, /\/api\/v1\/chat\/G\/icon\?/);
	});

	it("refuses EVERY group-admin op when the Private API is OFF (no request)", async () => {
		const rec: RecordedRequest[] = [];
		await assert.rejects(
			() => renameBlueBubblesChat(base(rec, false), { chatGuid: "G", displayName: "x" }),
			/Private API/,
		);
		await assert.rejects(
			() => addBlueBubblesParticipant(base(rec, false), { chatGuid: "G", address: "+1" }),
			/Private API/,
		);
		await assert.rejects(
			() => removeBlueBubblesParticipant(base(rec, false), { chatGuid: "G", address: "+1" }),
			/Private API/,
		);
		await assert.rejects(() => leaveBlueBubblesChat(base(rec, false), { chatGuid: "G" }), /Private API/);
		await assert.rejects(
			() => setBlueBubblesGroupIcon(base(rec, false), { chatGuid: "G", bytes: new Uint8Array([1]) }),
			/Private API/,
		);
		// Not one of the refused ops hit the wire.
		assert.equal(rec.length, 0);
	});

	it("validates required params before any request", async () => {
		const rec: RecordedRequest[] = [];
		await assert.rejects(
			() => addBlueBubblesParticipant(base(rec, true), { chatGuid: "G", address: "  " }),
			/requires an address/,
		);
		await assert.rejects(
			() => renameBlueBubblesChat(base(rec, true), { chatGuid: "  ", displayName: "x" }),
			/requires a chatGuid/,
		);
		assert.equal(rec.length, 0);
	});
});
