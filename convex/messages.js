// convex/messages.ts — sessionTranscriptRecords + sessionInboxEvents
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
export const appendRecord = mutation({
    args: {
        agentId: v.string(),
        sessionId: v.string(),
        type: v.string(),
        customType: v.optional(v.string()),
        payload: v.bytes(),
    },
    handler: async (ctx, args) => {
        // Compute next seq under the agent+session lane. Convex serialises
        // mutations on the same row keys, so this is race-safe.
        const tail = await ctx.db
            .query("sessionTranscriptRecords")
            .withIndex("by_session_seq", (q) => q.eq("agentId", args.agentId).eq("sessionId", args.sessionId))
            .order("desc")
            .first();
        const seq = (tail?.seq ?? 0) + 1;
        await ctx.db.insert("sessionTranscriptRecords", {
            agentId: args.agentId,
            sessionId: args.sessionId,
            seq,
            type: args.type,
            ...(args.customType !== undefined ? { customType: args.customType } : {}),
            payload: args.payload,
            createdAt: Date.now(),
        });
        return { seq };
    },
});
/** Ordered batch append — the convex-mode SessionManager write-behind queue
 *  flushes whole batches in one transaction so a mid-batch crash can't leave
 *  a torn parent-id chain. */
export const appendRecordsBatch = mutation({
    args: {
        agentId: v.string(),
        sessionId: v.string(),
        records: v.array(v.object({
            type: v.string(),
            customType: v.optional(v.string()),
            payload: v.bytes(),
        })),
    },
    handler: async (ctx, args) => {
        const tail = await ctx.db
            .query("sessionTranscriptRecords")
            .withIndex("by_session_seq", (q) => q.eq("agentId", args.agentId).eq("sessionId", args.sessionId))
            .order("desc")
            .first();
        let seq = (tail?.seq ?? 0) + 1;
        const now = Date.now();
        for (const r of args.records) {
            await ctx.db.insert("sessionTranscriptRecords", {
                agentId: args.agentId,
                sessionId: args.sessionId,
                seq,
                type: r.type,
                ...(r.customType !== undefined ? { customType: r.customType } : {}),
                payload: r.payload,
                createdAt: now,
            });
            seq += 1;
        }
        return { lastSeq: seq - 1 };
    },
});
/** Wholesale transcript replace — realises Pi's `_rewriteFile` (v1→v3
 *  migration, branch extraction) as one transaction. */
export const replaceTranscript = mutation({
    args: {
        agentId: v.string(),
        sessionId: v.string(),
        records: v.array(v.object({
            type: v.string(),
            customType: v.optional(v.string()),
            payload: v.bytes(),
        })),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("sessionTranscriptRecords")
            .withIndex("by_session_seq", (q) => q.eq("agentId", args.agentId).eq("sessionId", args.sessionId))
            .collect();
        for (const r of existing)
            await ctx.db.delete(r._id);
        const now = Date.now();
        let seq = 1;
        for (const r of args.records) {
            await ctx.db.insert("sessionTranscriptRecords", {
                agentId: args.agentId,
                sessionId: args.sessionId,
                seq,
                type: r.type,
                ...(r.customType !== undefined ? { customType: r.customType } : {}),
                payload: r.payload,
                createdAt: now,
            });
            seq += 1;
        }
        return { count: args.records.length };
    },
});
export const readTranscript = query({
    args: {
        agentId: v.string(),
        sessionId: v.string(),
        limit: v.optional(v.number()),
        // Cursor for pagination: return only records with seq > afterSeq. The
        // client loops with the last page's max seq so a transcript larger than
        // Convex's per-query read cap (~16k docs / 8MB) is read across calls
        // instead of silently truncating at `take(limit)`.
        afterSeq: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        // Cap a single page well under Convex's per-query document limit.
        const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 4000) : 1000;
        const after = args.afterSeq;
        const rows = await ctx.db
            .query("sessionTranscriptRecords")
            .withIndex("by_session_seq", (q) => after !== undefined
            ? q.eq("agentId", args.agentId).eq("sessionId", args.sessionId).gt("seq", after)
            : q.eq("agentId", args.agentId).eq("sessionId", args.sessionId))
            .order("asc")
            .take(limit);
        return rows;
    },
});
/** Newest-first tail of (type, customType) only — for the bootstrap-delivery
 *  check, which must honour compaction-invalidation (a compaction newer than
 *  the marker means the bootstrap context was compacted out → re-deliver).
 *  Returns just the two fields the walk needs, not the sealed payloads. */
export const readMarkerTail = query({
    args: { agentId: v.string(), sessionId: v.string(), limit: v.optional(v.number()) },
    handler: async (ctx, args) => {
        const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 1000) : 500;
        const rows = await ctx.db
            .query("sessionTranscriptRecords")
            .withIndex("by_session_seq", (q) => q.eq("agentId", args.agentId).eq("sessionId", args.sessionId))
            .order("desc")
            .take(limit);
        return rows.map((r) => ({ type: r.type, customType: r.customType }));
    },
});
export const deleteTranscript = mutation({
    args: { agentId: v.string(), sessionId: v.string() },
    handler: async (ctx, args) => {
        const rows = await ctx.db
            .query("sessionTranscriptRecords")
            .withIndex("by_session_seq", (q) => q.eq("agentId", args.agentId).eq("sessionId", args.sessionId))
            .collect();
        for (const r of rows)
            await ctx.db.delete(r._id);
        return rows.length;
    },
});
// ============================================================================
// Inbox (sessionInboxEvents)
// ============================================================================
export const inboxEnqueue = mutation({
    args: {
        sessionKey: v.string(),
        text: v.bytes(),
        // Client-supplied ts — areSystemEventsEqual (session-inbox.ts) does
        // ts-equality during prefix matching, so we MUST preserve the
        // producer's timestamp rather than stamping our own.
        ts: v.optional(v.number()),
        contextKey: v.optional(v.string()),
        deliveryContext: v.optional(v.any()),
        trusted: v.boolean(),
    },
    handler: async (ctx, args) => {
        const tail = await ctx.db
            .query("sessionInboxEvents")
            .withIndex("by_session_seq", (q) => q.eq("sessionKey", args.sessionKey))
            .order("desc")
            .first();
        const seq = (tail?.seq ?? 0) + 1;
        await ctx.db.insert("sessionInboxEvents", {
            sessionKey: args.sessionKey,
            seq,
            text: args.text,
            ts: args.ts ?? Date.now(),
            ...(args.contextKey !== undefined ? { contextKey: args.contextKey } : {}),
            ...(args.deliveryContext !== undefined ? { deliveryContext: args.deliveryContext } : {}),
            trusted: args.trusted,
        });
        return { seq };
    },
});
export const inboxPeek = query({
    args: { sessionKey: v.string() },
    handler: async (ctx, args) => {
        return ctx.db
            .query("sessionInboxEvents")
            .withIndex("by_session_seq", (q) => q.eq("sessionKey", args.sessionKey))
            .order("asc")
            .collect();
    },
});
export const inboxDrain = mutation({
    args: { sessionKey: v.string() },
    handler: async (ctx, args) => {
        const rows = await ctx.db
            .query("sessionInboxEvents")
            .withIndex("by_session_seq", (q) => q.eq("sessionKey", args.sessionKey))
            .order("asc")
            .collect();
        for (const r of rows)
            await ctx.db.delete(r._id);
        return rows;
    },
});
export const inboxConsumePrefix = mutation({
    args: { sessionKey: v.string(), prefixLength: v.number() },
    handler: async (ctx, args) => {
        const rows = await ctx.db
            .query("sessionInboxEvents")
            .withIndex("by_session_seq", (q) => q.eq("sessionKey", args.sessionKey))
            .order("asc")
            .take(args.prefixLength);
        for (const r of rows)
            await ctx.db.delete(r._id);
        return rows;
    },
});
export const inboxHasEvents = query({
    args: { sessionKey: v.string() },
    handler: async (ctx, args) => {
        const tail = await ctx.db
            .query("sessionInboxEvents")
            .withIndex("by_session_seq", (q) => q.eq("sessionKey", args.sessionKey))
            .first();
        return tail !== null;
    },
});
//# sourceMappingURL=messages.js.map