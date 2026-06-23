/**
 * SOCKS proxy dispatcher for grammY's undici-fetch transport.
 *
 * grammY drives every Telegram API call through Node's global `fetch` (undici),
 * which honours a `dispatcher` handed via `client.baseFetchConfig.dispatcher`.
 * undici's own `ProxyAgent` speaks ONLY HTTP CONNECT, so it cannot tunnel a
 * `socks://` / `socks5://` proxy. To support SOCKS we build a plain undici
 * `Agent` whose `connect` hook opens the TCP socket through the SOCKS proxy
 * (via the `socks` package) and then — for `https:` origins like
 * `api.telegram.org` — hands the raw socket to undici's TLS connector so the
 * handshake runs over the tunnel. This is the canonical "undici Agent + custom
 * connect" path and the dispatcher it returns is a drop-in for the HTTP(S)
 * `ProxyAgent` the direct path already uses.
 *
 * Ported from the reference Telegram proxy handling (its `makeProxyFetch`
 * collapses to the same SOCKS-aware connector underneath); only brand tokens
 * were scrubbed and the seam was reshaped to Brigade's lazy-import discipline.
 */

/** SOCKS protocol version inferred from the proxy URL scheme. */
type SocksType = 4 | 5;

/** Map a `socks*` URL scheme to the numeric type the `socks` package expects. */
function socksTypeForScheme(scheme: string): SocksType {
	switch (scheme.toLowerCase()) {
		case "socks4":
		case "socks4a":
			return 4;
		// socks / socks5 / socks5h all negotiate v5 (the `h` variant just means
		// "resolve DNS proxy-side", which is the default for our connect path
		// since we hand the hostname straight to the proxy).
		default:
			return 5;
	}
}

/** True when a proxy URL scheme names a SOCKS proxy (the ProxyAgent can't tunnel it). */
export function isSocksProxyScheme(scheme: string | undefined): boolean {
	if (!scheme) return false;
	const s = scheme.toLowerCase();
	return s === "socks" || s === "socks4" || s === "socks4a" || s === "socks5" || s === "socks5h";
}

/**
 * Build an undici dispatcher that tunnels through a SOCKS proxy. Lazy-imports
 * `undici` + `socks` (both heavy, only needed when a SOCKS proxy is configured)
 * so a non-proxy boot never pays for them. The returned object is an undici
 * `Agent` — `grammY` accepts it as `client.baseFetchConfig.dispatcher` exactly
 * like the HTTP(S) `ProxyAgent`.
 *
 * @throws if the proxy URL is malformed or the modules can't be loaded — the
 *         caller logs + falls back to a direct connection.
 */
export async function buildSocksDispatcher(proxyUrl: string): Promise<unknown> {
	const url = new URL(proxyUrl); // throws on a malformed URL → caller catches
	const { Agent, buildConnector } = await import("undici");
	const { SocksClient } = await import("socks");

	const type = socksTypeForScheme(url.protocol.replace(/:$/, ""));
	const socksProxy = {
		host: url.hostname,
		port: Number(url.port) || 1080,
		type,
		...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
		...(url.password ? { password: decodeURIComponent(url.password) } : {}),
	} as const;

	// undici's TLS connector — reused to wrap the SOCKS socket for https origins.
	const tlsConnect = buildConnector({});

	// undici's `connect` hook: (opts, callback) where callback is (err, socket).
	// We type it loosely (the exact `Dispatcher.connector` shape isn't exported in
	// a convenient form) and cast on the way into `Agent`.
	const connect = (
		opts: { hostname: string; port: number | string; protocol?: string; servername?: string },
		callback: (err: Error | null, socket: unknown) => void,
	): void => {
		const isTls = opts.protocol === "https:";
		const destPort = Number(opts.port) || (isTls ? 443 : 80);
		void SocksClient.createConnection({
			proxy: socksProxy,
			command: "connect",
			destination: { host: opts.hostname, port: destPort },
		})
			.then(({ socket }) => {
				if (!isTls) {
					(socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
					callback(null, socket);
					return;
				}
				// Upgrade the raw tunnel to TLS (api.telegram.org is https). undici's
				// connector performs the handshake over the supplied `httpSocket`.
				tlsConnect(
					{
						hostname: opts.hostname,
						host: opts.hostname,
						port: destPort,
						protocol: "https:",
						servername: opts.servername ?? opts.hostname,
						httpSocket: socket,
					} as never,
					callback as never,
				);
			})
			.catch((err: unknown) => {
				callback(err instanceof Error ? err : new Error(String(err)), null);
			});
	};

	return new Agent({ connect: connect as never });
}
