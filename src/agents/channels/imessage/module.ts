/**
 * iMessage extension module.
 *
 * Registers the iMessage channel adapter through the seam. The loader gates it
 * by the usual extension config (`extensions.disabled` / `entries`), and the
 * adapter itself only starts when `channels.imessage.enabled` is true AND a
 * runnable `imsg` binary resolves — so bundling this module is inert until the
 * operator opts in.
 *
 * Like Discord, iMessage registers NO gateway HTTP route: the `imsg rpc`
 * notification stream is the only inbound transport (a local subprocess, no
 * public URL needed). iMessage mirror of `discord/module.ts` (the no-webhook
 * shape).
 */

import { defineModule } from "../sdk.js";
import { createIMessageAdapter } from "./adapter.js";

export const imessageModule = defineModule({
	id: "imessage",
	register(b) {
		b.channel(createIMessageAdapter());
	},
});
