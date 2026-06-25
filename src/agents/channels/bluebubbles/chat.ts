/**
 * BlueBubbles chat-level REST actions — typing, mark-read, and group admin.
 *
 * These are the chat-scoped operations on top of the per-message send surface
 * in `send.ts`. Like every BlueBubbles REST helper they go through
 * `buildBlueBubblesApiUrl` + `blueBubblesFetchWithTimeout` (password in the
 * query string, INJECTABLE `fetchImpl` as the test seam) and share the
 * `BlueBubblesRestBase` shape.
 *
 * Surface:
 *   - `sendBlueBubblesTyping`        POST/DELETE chat/{guid}/typing (Private API)
 *   - `markBlueBubblesChatRead`      POST chat/{guid}/read          (Private API)
 *   - `renameBlueBubblesChat`        PUT  chat/{guid}               (Private API)
 *   - `addBlueBubblesParticipant`    POST chat/{guid}/participant/add    (Private API)
 *   - `removeBlueBubblesParticipant` POST chat/{guid}/participant/remove (Private API)
 *   - `leaveBlueBubblesChat`         POST chat/{guid}/leave         (Private API)
 *   - `setBlueBubblesGroupIcon`      POST chat/{guid}/icon (multipart) (Private API)
 *
 * EVERY action here needs the BlueBubbles server's Private API (the AppleScript /
 * helper bundle that drives Messages.app); a server with the Private API off
 * cannot type, mark-read, rename, or change membership. Typing + mark-read are
 * COSMETIC, so they silently no-op when the Private API is off (matching how the
 * pipeline treats read-receipts/typing as best-effort); the group-admin ops
 * THROW an operator-facing error so the agent tool can report the refusal.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
	blueBubblesFetchWithTimeout,
	buildBlueBubblesApiUrl,
	readBlueBubblesJson,
	type FetchLike,
} from "./types.js";
import type { BlueBubblesRestBase } from "./send.js";

/** Shared fetch-option assembly so every helper threads timeout + fetchImpl + the SSRF knob identically. */
function fetchOpts(base: BlueBubblesRestBase): { timeoutMs?: number; fetchImpl?: FetchLike; allowPrivateNetwork?: boolean } {
	return {
		...(base.timeoutMs !== undefined ? { timeoutMs: base.timeoutMs } : {}),
		...(base.fetchImpl ? { fetchImpl: base.fetchImpl } : {}),
		...(base.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	};
}

/** Refuse a Private-API-only group action when the server has the Private API off. */
function assertPrivateApi(base: BlueBubblesRestBase, feature: string): void {
	if (base.privateApiEnabled === false) {
		throw new Error(`BlueBubbles ${feature} requires the Private API to be enabled on the server`);
	}
}

/**
 * Signal "typing…" (or stop) in a chat. `POST` starts the indicator, `DELETE`
 * clears it. COSMETIC — silently no-ops when the Private API is off (a server
 * without it simply cannot drive the typing bubble). Best-effort: a transport
 * error propagates so the caller can swallow it (the pipeline treats typing as
 * cosmetic).
 */
export async function sendBlueBubblesTyping(
	base: BlueBubblesRestBase,
	params: { chatGuid: string; typing: boolean },
): Promise<void> {
	const chatGuid = (params.chatGuid ?? "").trim();
	if (!chatGuid) return;
	// Private API drives the typing indicator; without it there is nothing to do.
	if (base.privateApiEnabled === false) return;
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `chat/${encodeURIComponent(chatGuid)}/typing`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(url, { method: params.typing ? "POST" : "DELETE" }, fetchOpts(base));
	await readBlueBubblesJson(res, "chat/typing");
}

/**
 * Mark a chat read (clears the unread badge + sends a read receipt). COSMETIC —
 * silently no-ops when the Private API is off.
 */
export async function markBlueBubblesChatRead(
	base: BlueBubblesRestBase,
	params: { chatGuid: string },
): Promise<void> {
	const chatGuid = (params.chatGuid ?? "").trim();
	if (!chatGuid) return;
	if (base.privateApiEnabled === false) return;
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `chat/${encodeURIComponent(chatGuid)}/read`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(url, { method: "POST" }, fetchOpts(base));
	await readBlueBubblesJson(res, "chat/read");
}

/** Rename a group chat's display name (Private API). */
export async function renameBlueBubblesChat(
	base: BlueBubblesRestBase,
	params: { chatGuid: string; displayName: string },
): Promise<void> {
	assertPrivateApi(base, "group rename");
	const chatGuid = (params.chatGuid ?? "").trim();
	if (!chatGuid) throw new Error("BlueBubbles group rename requires a chatGuid");
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `chat/${encodeURIComponent(chatGuid)}`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(
		url,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ displayName: params.displayName ?? "" }),
		},
		fetchOpts(base),
	);
	await readBlueBubblesJson(res, "chat/rename");
}

/** Add a participant (phone/email handle) to a group chat (Private API). */
export async function addBlueBubblesParticipant(
	base: BlueBubblesRestBase,
	params: { chatGuid: string; address: string },
): Promise<void> {
	assertPrivateApi(base, "add participant");
	const chatGuid = (params.chatGuid ?? "").trim();
	const address = (params.address ?? "").trim();
	if (!chatGuid) throw new Error("BlueBubbles add participant requires a chatGuid");
	if (!address) throw new Error("BlueBubbles add participant requires an address");
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `chat/${encodeURIComponent(chatGuid)}/participant/add`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(
		url,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) },
		fetchOpts(base),
	);
	await readBlueBubblesJson(res, "chat/participant/add");
}

/** Remove a participant (phone/email handle) from a group chat (Private API). */
export async function removeBlueBubblesParticipant(
	base: BlueBubblesRestBase,
	params: { chatGuid: string; address: string },
): Promise<void> {
	assertPrivateApi(base, "remove participant");
	const chatGuid = (params.chatGuid ?? "").trim();
	const address = (params.address ?? "").trim();
	if (!chatGuid) throw new Error("BlueBubbles remove participant requires a chatGuid");
	if (!address) throw new Error("BlueBubbles remove participant requires an address");
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `chat/${encodeURIComponent(chatGuid)}/participant/remove`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(
		url,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) },
		fetchOpts(base),
	);
	await readBlueBubblesJson(res, "chat/participant/remove");
}

/** Leave a group chat (Private API). */
export async function leaveBlueBubblesChat(
	base: BlueBubblesRestBase,
	params: { chatGuid: string },
): Promise<void> {
	assertPrivateApi(base, "leave group");
	const chatGuid = (params.chatGuid ?? "").trim();
	if (!chatGuid) throw new Error("BlueBubbles leave group requires a chatGuid");
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `chat/${encodeURIComponent(chatGuid)}/leave`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(url, { method: "POST" }, fetchOpts(base));
	await readBlueBubblesJson(res, "chat/leave");
}

/** Sanitise a filename for a multipart header (CWE-93 / header injection guard). */
function sanitizeIconFilename(name: string): string {
	const base = path.basename(name || "icon.png").replace(/[\r\n"\\]/g, "_").trim();
	return base || "icon.png";
}

/**
 * Set (or change) a group chat's icon/photo via a multipart upload (Private
 * API). `bytes` is the image; `filename` is sanitised. A longer default timeout
 * applies (uploads are heavier than a JSON call).
 */
export async function setBlueBubblesGroupIcon(
	base: BlueBubblesRestBase,
	params: { chatGuid: string; bytes: Uint8Array; filename?: string; contentType?: string },
): Promise<void> {
	assertPrivateApi(base, "set group icon");
	const chatGuid = (params.chatGuid ?? "").trim();
	if (!chatGuid) throw new Error("BlueBubbles set group icon requires a chatGuid");
	if (!params.bytes || params.bytes.length === 0) throw new Error("BlueBubbles set group icon requires image bytes");
	const filename = sanitizeIconFilename(params.filename ?? "icon.png");
	const form = new FormData();
	const ab = params.bytes.buffer.slice(
		params.bytes.byteOffset,
		params.bytes.byteOffset + params.bytes.byteLength,
	) as ArrayBuffer;
	const blob = new Blob([ab], params.contentType ? { type: params.contentType } : {});
	form.append("icon", blob, filename);
	form.append("tempGuid", `temp-${Date.now()}-${randomUUID().slice(0, 8)}`);
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `chat/${encodeURIComponent(chatGuid)}/icon`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(
		url,
		{ method: "POST", body: form },
		// Uploads can be large — give a generous default timeout.
		{ ...fetchOpts(base), timeoutMs: base.timeoutMs ?? 60_000 },
	);
	await readBlueBubblesJson(res, "chat/icon");
}
