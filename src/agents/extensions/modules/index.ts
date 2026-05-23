/**
 * Bundled (in-tree) Brigade extension modules.
 *
 * Each capability ships as a module that registers itself through the seam.
 * They land here in build order: whatsapp first, then more channels, sub-agents,
 * cron, voice, … User modules dropped in `~/.brigade/extensions/` are discovered
 * + loaded by the loader alongside these (same gating) — see `discovery.ts`.
 */

import { whatsAppModule } from "../../channels/whatsapp/module.js";
import { duckduckgoModule } from "./duckduckgo.js";
import { firecrawlModule } from "./firecrawl.js";
import type { BrigadeModule } from "../types.js";

export const BUNDLED_MODULES: BrigadeModule[] = [
	whatsAppModule,
	// Web-search provider: keyless HTML scraper. Activates by default — sorted last
	// by `autoDetectOrder=100` so any keyed provider an operator adds wins.
	duckduckgoModule,
	// Web-fetch provider: API-key gated. Inert until `FIRECRAWL_API_KEY` is set;
	// then it auto-becomes the fallback when the built-in raw fetcher fails or
	// returns non-2xx (JS-heavy pages, bot-blocked sites).
	firecrawlModule,
];
