import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	convertToOllamaMessages,
	createOllamaStreamFn,
	extractOllamaTools,
	parseNdjsonStream,
	resolveOllamaChatUrl,
} from "./stream.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetchNdjson(lines: string[], captured?: { body?: unknown; headers?: unknown }): void {
	const enc = new TextEncoder();
	globalThis.fetch = (async (_url: string, init?: { body?: string; headers?: unknown }) => {
		if (captured && init?.body) captured.body = JSON.parse(init.body);
		if (captured && init?.headers) captured.headers = init.headers;
		return {
			ok: true,
			status: 200,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					for (const l of lines) controller.enqueue(enc.encode(`${l}\n`));
					controller.close();
				},
			}),
			text: async () => "",
		};
	}) as unknown as typeof fetch;
}

const MODEL = {
	id: "ollama/qwen3.6",
	api: "ollama",
	provider: "ollama",
	contextWindow: 32768,
	baseUrl: "http://localhost:11434/v1",
} as never;

async function drain(stream: { [Symbol.asyncIterator](): AsyncIterator<unknown>; result(): Promise<unknown> }) {
	const events: any[] = [];
	for await (const ev of stream) events.push(ev);
	const message = (await stream.result()) as any;
	return { events, message };
}

describe("resolveOllamaChatUrl", () => {
	it("strips trailing slash + /v1 and appends /api/chat", () => {
		assert.equal(resolveOllamaChatUrl("http://localhost:11434/v1"), "http://localhost:11434/api/chat");
		assert.equal(resolveOllamaChatUrl("http://host:11434/"), "http://host:11434/api/chat");
		assert.equal(resolveOllamaChatUrl(""), "http://127.0.0.1:11434/api/chat");
	});
});

describe("convertToOllamaMessages", () => {
	it("maps system/user/assistant/tool with images + tool_calls (content always a string)", () => {
		const out = convertToOllamaMessages(
			[
				{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "BASE64" }] },
				{ role: "assistant", content: [{ type: "toolCall", id: "x", name: "web_search", arguments: { q: "a" } }] },
				{ role: "toolResult", content: [{ type: "text", text: "result" }], toolName: "web_search" },
			],
			"you are brigade",
		);
		assert.deepEqual(out[0], { role: "system", content: "you are brigade" });
		assert.deepEqual(out[1], { role: "user", content: "hi", images: ["BASE64"] });
		assert.deepEqual(out[2], { role: "assistant", content: "", tool_calls: [{ function: { name: "web_search", arguments: { q: "a" } } }] });
		assert.deepEqual(out[3], { role: "tool", content: "result", tool_name: "web_search" });
	});
});

describe("extractOllamaTools", () => {
	it("maps Pi tools to function-tool shape, passing the schema through", () => {
		const out = extractOllamaTools([
			{ name: "web_search", description: "search", parameters: { type: "object", properties: {} } } as never,
			{ name: "", description: "skip me" } as never,
		]);
		assert.equal(out.length, 1);
		assert.deepEqual(out[0], {
			type: "function",
			function: { name: "web_search", description: "search", parameters: { type: "object", properties: {} } },
		});
	});
});

describe("parseNdjsonStream", () => {
	it("buffers lines across chunks and skips malformed/blank lines", async () => {
		const enc = new TextEncoder();
		const reader = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode('{"a":1}\n{"b'));
				c.enqueue(enc.encode('":2}\n\nnot-json\n{"c":3}'));
				c.close();
			},
		}).getReader();
		const got: unknown[] = [];
		for await (const obj of parseNdjsonStream(reader)) got.push(obj);
		assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
});

describe("createOllamaStreamFn — native /api/chat", () => {
	it("emits text + a STRUCTURED tool call, with toolUse stop reason and token usage", async () => {
		const captured: { body?: any } = {};
		mockFetchNdjson(
			[
				'{"message":{"role":"assistant","content":"Hello"}}',
				'{"message":{"role":"assistant","tool_calls":[{"function":{"name":"web_search","arguments":{"query":"ai news"}}}]}}',
				'{"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5}',
			],
			captured,
		);
		const fn = createOllamaStreamFn();
		const stream = fn(
			MODEL,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "news?" }], tools: [{ name: "web_search", description: "", parameters: {} }] } as never,
			{} as never,
		);
		const { events, message } = await drain(stream as never);

		// The request went to /api/chat with num_ctx + tools + stripped model id.
		assert.equal(captured.body.model, "qwen3.6");
		assert.equal(captured.body.options.num_ctx, 32768);
		assert.equal(captured.body.tools.length, 1);
		// Thinking is sent EXPLICITLY off — never omitted. An omitted `think` lets Ollama default
		// reasoning-capable models to thinking-ON, which makes them narrate tool calls as prose instead
		// of emitting structured calls. Sending `think:false` is the crux of native tool-calling working.
		assert.equal(captured.body.think, false);

		// The structured tool call survived (this is the whole point of native).
		const toolCall = message.content.find((b: any) => b.type === "toolCall");
		assert.ok(toolCall, "expected a structured toolCall block");
		assert.equal(toolCall.name, "web_search");
		assert.deepEqual(toolCall.arguments, { query: "ai news" });
		assert.equal(message.content.find((b: any) => b.type === "text")?.text, "Hello");
		assert.equal(message.stopReason, "toolUse");
		assert.equal(message.usage.input, 10);
		assert.equal(message.usage.output, 5);
		assert.equal(message.usage.cost.total, 0);

		// Event protocol: start → text_* → done(toolUse).
		assert.equal(events[0].type, "start");
		assert.ok(events.some((e) => e.type === "text_delta" && e.delta === "Hello"));
		assert.equal(events.at(-1).type, "done");
		assert.equal(events.at(-1).reason, "toolUse");
	});

	it("emits thinking then text as separate blocks", async () => {
		mockFetchNdjson([
			'{"message":{"thinking":"let me think"}}',
			'{"message":{"content":"answer"}}',
			'{"done":true,"prompt_eval_count":1,"eval_count":1}',
		]);
		const fn = createOllamaStreamFn();
		const stream = fn(MODEL, { messages: [{ role: "user", content: "q" }] } as never, {} as never);
		const { events, message } = await drain(stream as never);
		assert.equal(message.content[0].type, "thinking");
		assert.equal(message.content[0].thinking, "let me think");
		assert.equal(message.content[1].type, "text");
		assert.equal(message.content[1].text, "answer");
		assert.equal(message.stopReason, "stop");
		assert.ok(events.some((e) => e.type === "thinking_end"));
		// thinking closes before text starts
		const tEnd = events.findIndex((e) => e.type === "thinking_end");
		const txtStart = events.findIndex((e) => e.type === "text_start");
		assert.ok(tEnd >= 0 && txtStart > tEnd);
	});

	it("sends think:true when thinking level is explicitly on", async () => {
		const captured: { body?: any } = {};
		mockFetchNdjson(['{"message":{"content":"ok"}}', '{"done":true}'], captured);
		const fn = createOllamaStreamFn();
		const stream = fn(MODEL, { messages: [] } as never, { reasoning: "low" } as never);
		await drain(stream as never);
		assert.equal(captured.body.think, true);
	});

	it("does NOT send a Bearer header for the local sentinel key, but DOES for a real key", async () => {
		const sentinel: { headers?: any } = {};
		mockFetchNdjson(['{"done":true}'], sentinel);
		await drain(createOllamaStreamFn()(MODEL, { messages: [] } as never, { apiKey: "ollama-local-no-auth-required" } as never) as never);
		assert.equal(sentinel.headers?.Authorization, undefined);

		const real: { headers?: any } = {};
		mockFetchNdjson(['{"done":true}'], real);
		await drain(createOllamaStreamFn()(MODEL, { messages: [] } as never, { apiKey: "sk-real-cloud-key" } as never) as never);
		assert.equal(real.headers?.Authorization, "Bearer sk-real-cloud-key");
	});

	it("caps num_ctx for huge-context models so they don't OOM the KV cache", async () => {
		const bigModel = { ...(MODEL as object), contextWindow: 131072 } as never;
		const captured: { body?: any } = {};
		mockFetchNdjson(['{"done":true}'], captured);
		await drain(createOllamaStreamFn()(bigModel, { messages: [] } as never, {} as never) as never);
		assert.equal(captured.body.options.num_ctx, 65536, "131k window capped to the 64k default");
	});

	it("honors BRIGADE_OLLAMA_NUM_CTX env override for num_ctx", async () => {
		const prev = process.env.BRIGADE_OLLAMA_NUM_CTX;
		process.env.BRIGADE_OLLAMA_NUM_CTX = "8192";
		try {
			const captured: { body?: any } = {};
			mockFetchNdjson(['{"done":true}'], captured);
			await drain(createOllamaStreamFn()(MODEL, { messages: [] } as never, {} as never) as never);
			assert.equal(captured.body.options.num_ctx, 8192);
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_OLLAMA_NUM_CTX;
			else process.env.BRIGADE_OLLAMA_NUM_CTX = prev;
		}
	});

	it("encodes a failed request as an error event, never throws", async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 500, body: null, text: async () => "boom" })) as unknown as typeof fetch;
		const fn = createOllamaStreamFn();
		const stream = fn(MODEL, { messages: [] } as never, {} as never);
		const { message } = await drain(stream as never);
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage ?? "", /500/);
	});

	it("fails the turn when the stream ends without a done marker (dropped connection), not a silent partial", async () => {
		// Content streamed, then the connection closed WITHOUT a final `{done:true}` chunk.
		// A truncated turn must surface as an error (→ retry), never as a clean completion —
		// acting on a half-streamed tool call or sentence is a correctness hazard.
		mockFetchNdjson(['{"message":{"content":"partial ans"}}']);
		const fn = createOllamaStreamFn();
		const stream = fn(MODEL, { messages: [{ role: "user", content: "q" }] } as never, {} as never);
		const { message } = await drain(stream as never);
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage ?? "", /without a final response|dropped mid-generation/i);
	});

	it("emits `start` even for a PURE tool-call turn (no text/thinking preamble)", async () => {
		// Ollama's headline agentic case: the model calls a tool with zero prose. The
		// event stream must still open with `start` (not jump straight to `done`), or
		// a streaming UI shows nothing and start-keyed consumers mishandle the turn.
		mockFetchNdjson([
			'{"message":{"role":"assistant","tool_calls":[{"function":{"name":"web_search","arguments":{"q":"x"}}}]},"done":true}',
		]);
		const fn = createOllamaStreamFn();
		const stream = fn(
			MODEL,
			{ messages: [{ role: "user", content: "go" }], tools: [{ name: "web_search", description: "", parameters: {} }] } as never,
			{} as never,
		);
		const { events, message } = await drain(stream as never);
		assert.equal(events[0].type, "start", "start must be the first event even with no text/thinking");
		assert.equal(events.at(-1).type, "done");
		assert.equal(message.stopReason, "toolUse");
		assert.ok(message.content.some((b: any) => b.type === "toolCall"), "the tool call is present");
	});

	it('maps done_reason:"length" to StopReason "length" (num_predict truncation ≠ clean stop)', async () => {
		mockFetchNdjson([
			'{"message":{"content":"partial"}}',
			'{"done":true,"done_reason":"length","prompt_eval_count":2,"eval_count":9}',
		]);
		const fn = createOllamaStreamFn();
		const stream = fn(MODEL, { messages: [{ role: "user", content: "q" }] } as never, {} as never);
		const { events, message } = await drain(stream as never);
		assert.equal(message.stopReason, "length");
		assert.equal(events.at(-1).type, "done");
		assert.equal(events.at(-1).reason, "length");
	});

	it("uses ONE stable timestamp across ALL streamed frames (else the connect render draws a new line per token)", async () => {
		// The connect-mode render identity-keys an assistant block by `<depth>:<timestamp>`.
		// A fresh Date.now() per partial makes every token a new "brigade" line. Every
		// frame (start/text_*/done) + the final message MUST carry one shared timestamp.
		mockFetchNdjson([
			'{"message":{"content":"Hey"}}',
			'{"message":{"content":"!"}}',
			'{"message":{"content":" there"}}',
			'{"done":true,"prompt_eval_count":1,"eval_count":3}',
		]);
		const stream = createOllamaStreamFn()(MODEL, { messages: [{ role: "user", content: "hi" }] } as never, {} as never);
		const { events, message } = await drain(stream as never);
		const stamps = new Set<number>();
		for (const e of events as any[]) {
			const ts = e.partial?.timestamp ?? e.message?.timestamp ?? e.error?.timestamp;
			if (typeof ts === "number") stamps.add(ts);
		}
		stamps.add(message.timestamp);
		assert.equal(stamps.size, 1, `all streamed frames must share ONE timestamp (got ${[...stamps].join(", ")})`);
	});

	it("drops tools + retries once when Ollama 400s with 'does not support tools' (vision-only model), then caches it", async () => {
		const enc = new TextEncoder();
		const bodies: any[] = [];
		let call = 0;
		globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
			call += 1;
			if (init?.body) bodies.push(JSON.parse(init.body));
			if (call === 1) {
				return { ok: false, status: 400, body: null, text: async () => '"llava" does not support tools' };
			}
			return {
				ok: true,
				status: 200,
				body: new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(enc.encode('{"message":{"content":"a cat"}}\n'));
						c.enqueue(enc.encode('{"done":true}\n'));
						c.close();
					},
				}),
				text: async () => "",
			};
		}) as unknown as typeof fetch;

		const visionModel = { ...(MODEL as object), id: "ollama/llava:latest" } as never;
		const toolCtx = { messages: [{ role: "user", content: "what's this" }], tools: [{ name: "web_search", description: "", parameters: {} }] } as never;
		const { message } = await drain(createOllamaStreamFn()(visionModel, toolCtx, {} as never) as never);

		assert.equal(call, 2, "retried exactly once");
		assert.ok(Array.isArray(bodies[0].tools) && bodies[0].tools.length > 0, "first attempt sent tools");
		assert.equal(bodies[1].tools, undefined, "retry omitted tools");
		assert.equal(message.stopReason, "stop");
		assert.equal(message.content.find((b: any) => b.type === "text")?.text, "a cat");

		// Cached for the rest of the process: a second turn omits tools on the FIRST attempt.
		const bodies2: any[] = [];
		let call2 = 0;
		globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
			call2 += 1;
			if (init?.body) bodies2.push(JSON.parse(init.body));
			return {
				ok: true,
				status: 200,
				body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('{"done":true}\n')); c.close(); } }),
				text: async () => "",
			};
		}) as unknown as typeof fetch;
		await drain(createOllamaStreamFn()(visionModel, toolCtx, {} as never) as never);
		assert.equal(call2, 1, "no retry needed the second time");
		assert.equal(bodies2[0].tools, undefined, "cached: tools omitted on the first attempt");
	});
});
