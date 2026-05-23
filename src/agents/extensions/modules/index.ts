/**
 * Bundled (in-tree) Brigade extension modules.
 *
 * Each capability ships as a module that registers itself through the seam.
 * They land here in build order: whatsapp first, then more channels, sub-agents,
 * cron, voice, … User modules dropped in `~/.brigade/extensions/` are discovered
 * + loaded by the loader alongside these (same gating) — see `discovery.ts`.
 */

import { whatsAppModule } from "../../channels/whatsapp/module.js";
import { braveModule } from "./brave.js";
import { duckduckgoModule } from "./duckduckgo.js";
import { exaModule } from "./exa.js";
import { firecrawlModule } from "./firecrawl.js";
import { perplexityModule } from "./perplexity.js";
import { searxngModule } from "./searxng.js";
import { tavilyModule } from "./tavily.js";
import type { BrigadeModule } from "../types.js";

export const BUNDLED_MODULES: BrigadeModule[] = [
	whatsAppModule,
	// Web-fetch + web-search providers. Each module is inert unless its
	// credential is configured (env var or `tools.web.{search,fetch}.providers.<id>`).
	// The registry picks the active provider by `autoDetectOrder` ascending —
	// lower wins — so the operator's preferred backend lands when configured.
	//
	//   autoDetectOrder priority — lower number = picked sooner:
	//     10  Firecrawl fetch (key-gated, JS-heavy fallback)
	//     20  Tavily search (AI-answer, one-shot RAG)
	//     30  Brave search (structured native API)
	//     40  Exa search (neural / content extraction)
	//     45  Perplexity search (research-mode)
	//     50  Firecrawl search (same key as fetch)
	//     100 DuckDuckGo (keyless HTML scrape — fallback)
	//     180 SearXNG (self-hosted, operator-supplied URL)
	braveModule,
	duckduckgoModule,
	exaModule,
	firecrawlModule,
	perplexityModule,
	searxngModule,
	tavilyModule,
];
