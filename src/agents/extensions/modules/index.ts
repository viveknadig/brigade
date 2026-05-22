/**
 * Bundled (in-tree) Brigade extension modules.
 *
 * Each capability ships as a module that registers itself through the seam.
 * They land here in build order: memory (migrated), then web, then whatsapp,
 * then sub-agents, cron, voice, … User modules under `~/.brigade/extensions/`
 * are discovered separately by the loader (same gating).
 */

import { whatsAppModule } from "../../channels/whatsapp/module.js";
import type { BrigadeModule } from "../types.js";

export const BUNDLED_MODULES: BrigadeModule[] = [whatsAppModule];
