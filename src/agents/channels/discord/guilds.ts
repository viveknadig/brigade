/**
 * Discord guild listing — the cheap `GET /users/@me/guilds` call the directory
 * + diagnostics build on.
 *
 * Like `probe.ts` this is a SELF-CONTAINED REST call (no `discord.js`, no
 * Gateway socket): a single authenticated GET that returns the bot's joined
 * guilds. The directory walks these to enumerate members + channels; the
 * permission audit doesn't need them but other diagnostics might. Injectable
 * fetch (tests stub it); never throws — a failed call returns `[]`.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** One guild the bot belongs to (the subset callers read). */
export interface DiscordGuildSummary {
	/** Guild (server) id (snowflake). */
	id: string;
	/** Guild name. */
	name: string;
}

/**
 * List the guilds the bot is a member of via `GET /users/@me/guilds`. Returns
 * `{ id, name }` rows, skipping malformed entries. Best-effort: a network error
 * / non-ok / unparseable body returns `[]` (the caller degrades gracefully).
 * The token rides in the `Authorization: Bot <token>` header; never logged.
 */
export async function listDiscordGuilds(
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<DiscordGuildSummary[]> {
	const clean = (token ?? "").trim();
	if (!clean) return [];
	try {
		const res = await fetchImpl(`${DISCORD_API_BASE}/users/@me/guilds`, {
			method: "GET",
			headers: { Authorization: `Bot ${clean}`, "content-type": "application/json" },
		});
		if (!res.ok) return [];
		const body = (await res.json()) as Array<{ id?: unknown; name?: unknown }>;
		if (!Array.isArray(body)) return [];
		const out: DiscordGuildSummary[] = [];
		for (const g of body) {
			const id = typeof g?.id === "string" ? g.id.trim() : "";
			const name = typeof g?.name === "string" ? g.name.trim() : "";
			if (!id || !name) continue;
			out.push({ id, name });
		}
		return out;
	} catch {
		return [];
	}
}
