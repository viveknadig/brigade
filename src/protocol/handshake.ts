/**
 * Connect-frame + capability negotiation (Step 24).
 *
 * Brand-scrubbed analogue of upstream's connect/hello flow. Defines the
 * THREE moving parts of the handshake:
 *
 *   - `PROTOCOL_VERSION`  — single integer; bumped only on breaking changes
 *   - `ConnectParams`     — what the client sends in its first frame
 *   - `HelloOk`           — server's reply confirming version + features
 *
 * Brigade's gateway accepts clients of multiple types (TUI, web UI,
 * mobile, in-process agent tools). The shapes here are agnostic to
 * transport — the same types describe an in-process call and a remote
 * WebSocket.
 */

export const PROTOCOL_VERSION = 1 as const;

/* ─── Client identity ───────────────────────────────────────────── */

export const GatewayClientIds = {
	TUI: "brigade-tui",
	WEB_UI: "brigade-web",
	WEBCHAT: "brigade-webchat",
	CLI: "cli",
	GATEWAY_CLIENT: "gateway-client",
	MACOS_APP: "brigade-macos",
	IOS_APP: "brigade-ios",
	ANDROID_APP: "brigade-android",
	NODE_HOST: "node-host",
	TEST: "test",
	PROBE: "brigade-probe",
} as const;

export type GatewayClientId = (typeof GatewayClientIds)[keyof typeof GatewayClientIds];

export const GatewayClientModes = {
	WEBCHAT: "webchat",
	CLI: "cli",
	UI: "ui",
	BACKEND: "backend",
	NODE: "node",
	PROBE: "probe",
	TEST: "test",
} as const;

export type GatewayClientMode = (typeof GatewayClientModes)[keyof typeof GatewayClientModes];

export interface GatewayClientInfo {
	id: GatewayClientId;
	displayName?: string;
	version: string;
	platform: string;
	deviceFamily?: string;
	modelIdentifier?: string;
	mode: GatewayClientMode;
	instanceId?: string;
}

/* ─── Operator scopes ───────────────────────────────────────────── */

export const OperatorScopes = {
	ADMIN: "admin",
	APPROVALS: "approvals",
	PAIRING: "pairing",
	READ: "read",
	TALK_SECRETS: "talk-secrets",
	WRITE: "write",
} as const;

export type OperatorScope = (typeof OperatorScopes)[keyof typeof OperatorScopes];

/* ─── Connect frame (client → server) ───────────────────────────── */

export interface ConnectParams {
	minProtocol: number;
	maxProtocol: number;
	client: GatewayClientInfo;
	caps?: readonly string[];
	commands?: readonly string[];
	permissions?: Record<string, boolean>;
	role?: "operator" | "node" | "device" | string;
	scopes?: readonly OperatorScope[];
	auth?: {
		token?: string;
		bootstrapToken?: string;
		deviceToken?: string;
		password?: string;
	};
	locale?: string;
	userAgent?: string;
}

/* ─── Hello-ok reply (server → client) ──────────────────────────── */

export interface HelloOk {
	type: "hello-ok";
	protocol: number;
	server: {
		version: string;
		connId: string;
	};
	features: {
		methods: readonly string[];
		events: readonly string[];
	};
	policy: {
		maxPayload: number;
		maxBufferedBytes: number;
		tickIntervalMs: number;
	};
	auth?: {
		deviceToken?: string;
		role?: string;
		scopes?: readonly OperatorScope[];
		issuedAtMs?: number;
	};
}
