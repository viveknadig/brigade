/**
 * Proxy agent builder for the Slack SDKs.
 *
 * Both `@slack/web-api` (`WebClient`) and `@slack/socket-mode`
 * (`SocketModeClient`) accept an `agent` option that is a standard Node
 * `http(s).Agent` (they drive HTTP via `node-fetch` + open the Socket Mode
 * websocket via `ws`, both of which honour an injected agent). To route Slack
 * through a proxy we build the matching agent from the proxy URL scheme:
 *
 *   - `http://` / `https://`  → an HTTP CONNECT proxy via `https-proxy-agent`.
 *   - `socks` / `socks4(a)` / `socks5(h)` → a SOCKS proxy via `socks-proxy-agent`.
 *
 * Both packages are lazy-imported (only paid for when a proxy is configured) and
 * produce an `http.Agent` the Slack SDKs use as-is — the analogue of Telegram's
 * undici dispatcher, reshaped to the agent seam the Slack SDKs expose. A
 * malformed URL / missing module throws; the caller logs + connects directly.
 */

/** True when a proxy URL scheme names a SOCKS proxy (needs the SOCKS agent). */
export function isSocksProxyScheme(scheme: string | undefined): boolean {
	if (!scheme) return false;
	const s = scheme.toLowerCase();
	return s === "socks" || s === "socks4" || s === "socks4a" || s === "socks5" || s === "socks5h";
}

/**
 * Build a Node `http.Agent` that tunnels through `proxyUrl`. SOCKS schemes use
 * `socks-proxy-agent`; everything else (http/https) uses `https-proxy-agent`.
 * The returned agent is handed to `new WebClient(token, { agent })` and to the
 * `SocketModeClient({ appToken, clientOptions: { agent } })` construction.
 *
 * @throws if the proxy URL is malformed or a module can't be loaded — the caller
 *         logs + falls back to a direct connection.
 */
export async function buildSlackProxyAgent(proxyUrl: string): Promise<unknown> {
	const url = new URL(proxyUrl); // throws on a malformed URL → caller catches
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (isSocksProxyScheme(scheme)) {
		const { SocksProxyAgent } = await import("socks-proxy-agent");
		return new SocksProxyAgent(proxyUrl);
	}
	const { HttpsProxyAgent } = await import("https-proxy-agent");
	return new HttpsProxyAgent(proxyUrl);
}
