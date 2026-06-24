import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/types.js";
import { BrigadeExtensionRegistry } from "../../extensions/registry.js";
import {
	registerSlackAccountSink,
	resetSlackAccountSinksForTests,
	type SlackAccountSink,
} from "./account-registry.js";
import { slackModule } from "./module.js";
import { SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER } from "./webhook.js";

const META_BASE = { agentId: "main", workspaceDir: "/ws", cwd: "/cwd" };

/** Build a real `b` whose httpRoute calls land in `reg.httpRoutes`. */
function contextFor(config: unknown) {
	const reg = new BrigadeExtensionRegistry();
	const b = reg.context({ ...META_BASE, config: config as BrigadeConfig });
	return { reg, b };
}

/** A recording sink + the secret its account verifies with. */
function makeSink(): SlackAccountSink & { fed: Array<{ kind: string; payload: unknown }> } {
	const fed: Array<{ kind: string; payload: unknown }> = [];
	return { fed, feedWebhookEvent: (kind, payload) => fed.push({ kind, payload }) };
}

function sign(secret: string, rawBody: string, ts: string): string {
	return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
}

function fakeReq(headers: Record<string, string>, body: string): EventEmitter & { method: string; headers: Record<string, string | string[] | undefined>; body: Buffer } {
	const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string | string[] | undefined>; body: Buffer };
	req.method = "POST";
	req.headers = headers;
	req.body = Buffer.from(body, "utf8"); // gateway pre-buffers the body onto req.body
	return req;
}

function fakeRes(): { statusCode: number; body: string; setHeader: () => void; end: (b?: string) => void } {
	const res = { statusCode: 0, body: "", setHeader: () => {}, end: (b?: string) => { res.body = b ?? ""; } };
	return res;
}

describe("slackModule.register — transport routing", () => {
	afterEach(() => resetSlackAccountSinksForTests());

	it("socket mode (default) registers NO http route", () => {
		const { reg, b } = contextFor({ channels: { slack: { enabled: true, botToken: "xoxb-A", appToken: "xapp-A" } } });
		void slackModule.register(b);
		assert.equal(reg.httpRoutes.length, 0);
	});

	it("single-workspace events mode registers ONE route on the base path", () => {
		const { reg, b } = contextFor({
			channels: { slack: { enabled: true, mode: "events", botToken: "xoxb-A", signingSecret: "s" } },
		});
		void slackModule.register(b);
		assert.equal(reg.httpRoutes.length, 1);
		assert.equal(reg.httpRoutes[0]?.path, "/slack/events");
	});

	it("two workspaces in events mode register TWO distinct routes", () => {
		const { reg, b } = contextFor({
			channels: {
				slack: {
					enabled: true,
					mode: "events",
					accounts: [
						{ id: "acme", botToken: "xoxb-A", signingSecret: "secA" },
						{ id: "labs", botToken: "xoxb-B", signingSecret: "secB" },
					],
				},
			},
		});
		void slackModule.register(b);
		const paths = reg.httpRoutes.map((r) => r.path).sort();
		assert.equal(reg.httpRoutes.length, 2);
		assert.deepEqual(paths, ["/slack/events/acme", "/slack/events/labs"]);
	});

	it("an event POSTed to account B's path reaches account B's sink (not the default)", async () => {
		const { reg, b } = contextFor({
			channels: {
				slack: {
					enabled: true,
					mode: "events",
					accounts: [
						{ id: "acme", botToken: "xoxb-A", signingSecret: "secA" },
						{ id: "labs", botToken: "xoxb-B", signingSecret: "secB" },
					],
				},
			},
		});
		void slackModule.register(b);

		// Started adapters land in the registry on startAccount; simulate that here.
		const acme = makeSink();
		const labs = makeSink();
		registerSlackAccountSink("acme", acme);
		registerSlackAccountSink("labs", labs);

		const labsRoute = reg.httpRoutes.find((r) => r.path === "/slack/events/labs");
		assert.ok(labsRoute, "labs route registered");

		const ts = String(Math.floor(Date.now() / 1000));
		const body = JSON.stringify({ type: "event_callback", team_id: "TLABS", event: { type: "message", text: "for labs", ts: "1.1" } });
		const req = fakeReq(
			{ [SLACK_SIGNATURE_HEADER]: sign("secB", body, ts), [SLACK_TIMESTAMP_HEADER]: ts, "content-type": "application/json" },
			body,
		);
		const res = fakeRes();
		await labsRoute!.handler(req as never, res as never);

		assert.equal(res.statusCode, 200);
		assert.equal(labs.fed.length, 1, "labs sink received the event");
		assert.equal(labs.fed[0]?.kind, "event");
		assert.equal(acme.fed.length, 0, "acme sink did NOT receive labs's event");
	});

	it("each route verifies with ITS OWN account signing secret (B's secret is rejected on A's route)", async () => {
		const { reg, b } = contextFor({
			channels: {
				slack: {
					enabled: true,
					mode: "events",
					accounts: [
						{ id: "acme", botToken: "xoxb-A", signingSecret: "secA" },
						{ id: "labs", botToken: "xoxb-B", signingSecret: "secB" },
					],
				},
			},
		});
		void slackModule.register(b);
		registerSlackAccountSink("acme", makeSink());

		const acmeRoute = reg.httpRoutes.find((r) => r.path === "/slack/events/acme");
		assert.ok(acmeRoute);
		const ts = String(Math.floor(Date.now() / 1000));
		const body = JSON.stringify({ type: "event_callback", event: { type: "message", ts: "1.1" } });
		// Sign with labs's secret (wrong for acme's route) → must be rejected.
		const req = fakeReq(
			{ [SLACK_SIGNATURE_HEADER]: sign("secB", body, ts), [SLACK_TIMESTAMP_HEADER]: ts, "content-type": "application/json" },
			body,
		);
		const res = fakeRes();
		await acmeRoute!.handler(req as never, res as never);
		assert.equal(res.statusCode, 401);
	});
});
