/**
 * Regression guard for the TUI `/provider` "add a new provider inline" path
 * (gateway `add-provider` RPC). The handler's correctness rests on two facts
 * about the Pi runtime + Brigade catalog that this test pins:
 *
 *   1. Calling `authStorage.set(provider, {type:"api_key", key})` on the live
 *      boot store — then `modelRegistry.refresh()` — flips that provider's
 *      built-in models from "known but unavailable" to "available", WITHOUT a
 *      gateway restart. This is what makes the post-add `list-models` show the
 *      new provider's models so the follow-up `set-model` switch can land.
 *
 *   2. Every provider the TUI offers for INLINE add (plain API-key catalog
 *      entries) actually has built-in Pi models, so the switch-after-add never
 *      dead-ends on "no models available". custom / local / subscription /
 *      cli-login providers are deliberately routed to `brigade onboard`.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { PROVIDERS } from "./catalog.js";

// Mirror connect.ts's `isInlineAddable`: plain API-key catalog entries only.
const inlineAddable = PROVIDERS.filter(
	(pr) => !pr.noAuth && !pr.custom && !pr.subscription && !pr.cliLogin,
);

describe("provider hot-add — authStorage.set() makes models available without restart", () => {
	it("an unconfigured provider has built-in models that become available after set()+refresh()", () => {
		// Empty auth + a non-existent models.json → only Pi's built-in catalog,
		// none of which is "available" because nothing has auth configured.
		const auth = AuthStorage.inMemory({});
		const registry = ModelRegistry.create(auth, "/tmp/__brigade_no_models.json");

		const builtinAnthropic = registry.getAll().filter((m) => m.provider === "anthropic");
		assert.ok(builtinAnthropic.length > 0, "Pi should ship built-in anthropic models");
		assert.equal(
			registry.getAvailable().filter((m) => m.provider === "anthropic").length,
			0,
			"no anthropic models available before a key is set",
		);
		assert.equal(auth.hasAuth("anthropic"), false);

		// Exactly what the `add-provider` handler does after persisting to disk.
		auth.set("anthropic", { type: "api_key", key: "sk-ant-test-not-real" });
		registry.refresh();

		assert.equal(auth.hasAuth("anthropic"), true);
		assert.equal(
			registry.getAvailable().filter((m) => m.provider === "anthropic").length,
			builtinAnthropic.length,
			"every built-in anthropic model is available once the key is set",
		);
	});

	it("refresh() does not wipe the hot-added in-memory credential", () => {
		const auth = AuthStorage.inMemory({});
		const registry = ModelRegistry.create(auth, "/tmp/__brigade_no_models.json");
		auth.set("openai", { type: "api_key", key: "sk-openai-test-not-real" });
		registry.refresh();
		registry.refresh(); // idempotent — a second refresh must not drop it
		assert.equal(auth.hasAuth("openai"), true);
		assert.ok(
			registry.getAvailable().some((m) => m.provider === "openai"),
			"openai models stay available across repeated refreshes",
		);
	});
});

describe("inline-addable catalog entries all resolve to built-in Pi models", () => {
	// One shared empty registry: built-in catalogue is independent of auth.
	const registry = ModelRegistry.create(AuthStorage.inMemory({}), "/tmp/__brigade_no_models.json");
	const builtinProviders = new Set(registry.getAll().map((m) => m.provider));

	for (const pr of inlineAddable) {
		it(`${pr.id} has built-in models (switch-after-add won't dead-end)`, () => {
			const routingId = pr.providerId ?? pr.id;
			assert.ok(
				builtinProviders.has(routingId),
				`inline-addable provider "${pr.id}" (routing "${routingId}") must have built-in Pi models, ` +
					`otherwise /provider would add the key then fail to switch. If this provider needs ` +
					`models.json, mark it custom in the catalog so it routes to the onboard wizard instead.`,
			);
		});
	}

	it("excludes custom / local / subscription / cli-login providers from inline add", () => {
		const ids = new Set(inlineAddable.map((p) => p.id));
		assert.equal(ids.has("ollama"), false, "local/no-auth provider must not be inline-addable");
		assert.equal(ids.has("custom"), false, "BYO custom endpoint must not be inline-addable");
		assert.equal(ids.has("glm"), false, "custom-endpoint provider must not be inline-addable");
		assert.equal(ids.has("claude-code"), false, "subscription provider must not be inline-addable");
	});
});
