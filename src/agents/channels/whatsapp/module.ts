/**
 * WhatsApp extension module.
 *
 * Registers the WhatsApp channel adapter through the seam. The loader gates it
 * by the usual extension config (`extensions.disabled` / `entries`), and the
 * adapter itself only starts when `channels.whatsapp.enabled` is true — so
 * bundling this module is inert until the operator opts in.
 */

import { defineModule } from "../../extensions/types.js";
import { createWhatsAppAdapter } from "./adapter.js";

export const whatsAppModule = defineModule({
	id: "whatsapp",
	register(b) {
		b.channel(createWhatsAppAdapter());
	},
});
