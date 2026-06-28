// Pure per-client subscription filter for the gateway WS broadcaster.
//
// Wave I closure: `connWantsFrame` inside `startServer` decides whether a
// connected client should receive a broadcast frame. It was inlined when
// Wave H landed but is now extracted so both the gateway and a focused
// unit test exercise the same predicate. The behaviour is unchanged:
//
//   - Untagged frames (no agentId, no sessionId) broadcast to everyone —
//     state snapshots / generic errors keep working without a subscribe.
//   - Clients with no subscriptions get every frame — legacy single-agent
//     TUI clients are not penalised for omitting the subscribe handshake.
//   - Otherwise the client must be subscribed to either the agentId or
//     sessionId on the frame; an explicit subscribe narrows the view.

export interface FrameTags {
	agentId?: string | undefined;
	sessionId?: string | undefined;
}

/** Pure predicate: does a client with these subs want this frame? */
export function shouldDeliverFrame(
	agentSubs: ReadonlySet<string> | undefined,
	sessionSubs: ReadonlySet<string> | undefined,
	tags: FrameTags,
): boolean {
	const { agentId, sessionId } = tags;
	if (!agentId && !sessionId) return true;
	if (!agentSubs && !sessionSubs) return true;
	if (agentId && agentSubs?.has(agentId)) return true;
	if (sessionId && sessionSubs) {
		// Exact match OR a sub-agent DESCENDANT session. A spawned sub-agent runs
		// under a child key (`<parent>:subagent:<id>`, see routing/session-key.ts),
		// so its pi frames + approval prompts must still reach the operator
		// watching the parent turn — otherwise sub-agent activity is invisible and
		// its `bash` approval prompt never surfaces (the turn then hangs on the
		// approval timeout). The trailing ":" stops a sibling like `…:main2` from
		// matching `…:main`.
		for (const sub of sessionSubs) {
			if (sessionId === sub || sessionId.startsWith(`${sub}:`)) return true;
		}
	}
	return false;
}

/** Cheap discriminator: pulls optional agentId/sessionId off a payload. */
export function extractFrameTags(payload: unknown): FrameTags {
	const obj = payload as { agentId?: unknown; sessionId?: unknown } | null;
	if (!obj || typeof obj !== "object") return {};
	const tags: FrameTags = {};
	if (typeof obj.agentId === "string") tags.agentId = obj.agentId;
	if (typeof obj.sessionId === "string") tags.sessionId = obj.sessionId;
	return tags;
}
