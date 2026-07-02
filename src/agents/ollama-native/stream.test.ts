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

function mockFetchNdjson(lines: string[], captured?: { body?: unknown }): void {
	const enc = new TextEncoder();
	globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
		if (captured && init?.body) captured.body = JSON.parse(init.body);
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
		assert.equal(captured.body.think, undefined); // no reasoning → thinking off

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

	it("encodes a failed request as an error event, never throws", async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 500, body: null, text: async () => "boom" })) as unknown as typeof fetch;
		const fn = createOllamaStreamFn();
		const stream = fn(MODEL, { messages: [] } as never, {} as never);
		const { message } = await drain(stream as never);
		assert.equal(message.stopReason, "error");
		assert.match(message.errorMessage ?? "", /500/);
	});
});
