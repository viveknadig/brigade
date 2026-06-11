// convex/admin.ts — instance-level inspect + factory reset.
//
// Single-operator deployments hold exactly one Brigade instance, so "reset
// the instance" means "delete every row in every Brigade table" (plus any
// File-Storage objects rows point at). Used by the onboarding wizard's
// "start fresh" choice and the `brigade store reset` CLI.
//
// Deletion is PAGINATED (`resetPage`) because a long-lived instance can hold
// tens of thousands of rows (cron runs, session events) and a single Convex
// mutation has document/size limits — the client loops each table until the
// page comes back short.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
// Every table in convex/schema.ts. Kept as an explicit literal union so a
// future schema addition that forgets to extend this list fails loudly in
// review rather than silently surviving a "factory reset".
const RESETTABLE_TABLES = [
    "brigadeConfig",
    "brigadeConfigAudit",
    "brigadeConfigBackups",
    "configHealth",
    "personaFiles",
    "workspaceState",
    "memoryFacts",
    "memoryExtractCursors",
    "memoryConsolidateState",
    "sessions",
    "sessionTranscriptRecords",
    "sessionInboxEvents",
    "sessionEvents",
    "subsystemLog",
    "cronJobs",
    "cronRuns",
    "cronServiceState",
    "channelAccess",
    "whatsappAuthFile",
    "channelMediaBlob",
    "authProfiles",
    "profileState",
    "authFiles",
    "systemMeta",
    "whatsappAuthCreds",
    "whatsappAuthKeys",
    "execApprovals",
    "skills",
    "extensions",
    "orgDeriveAudit",
    "orgChartCache",
    "subagentRuns",
    "gatewayCoord",
    "brigadeBlobs",
];
const TableName = v.union(...RESETTABLE_TABLES.map((t) => v.literal(t)));
// Tables whose rows can point at File-Storage objects — the object must be
// deleted BEFORE the row or it becomes an orphan (storage isn't ref-counted).
const STORAGE_SPILL_TABLES = new Set([
    "channelMediaBlob",
    "whatsappAuthKeys",
    "brigadeBlobs",
]);
/** The list the reset client iterates — exported via query so the CLI and
 *  the server can never drift on which tables exist. */
export const listResettableTables = query({
    args: {},
    handler: async () => [...RESETTABLE_TABLES],
});
/** Headline summary for "found an existing Brigade in this backend". */
export const instanceSummary = query({
    args: {},
    handler: async (ctx) => {
        const configRow = await ctx.db.query("brigadeConfig").first();
        const memories = await ctx.db.query("memoryFacts").take(1001);
        const sessions = await ctx.db.query("sessions").take(1001);
        const cronJobs = await ctx.db.query("cronJobs").take(1001);
        const personas = await ctx.db.query("personaFiles").take(1001);
        const waCreds = await ctx.db.query("whatsappAuthCreds").take(1);
        const fp = await ctx.db
            .query("systemMeta")
            .withIndex("by_key", (q) => q.eq("key", "encryptionFingerprint"))
            .first();
        const cap = (n) => Math.min(n, 1000);
        return {
            hasData: configRow !== null ||
                memories.length > 0 ||
                sessions.length > 0 ||
                cronJobs.length > 0 ||
                personas.length > 0,
            createdAtMs: configRow?._creationTime ?? null,
            counts: {
                memories: cap(memories.length),
                sessions: cap(sessions.length),
                cronJobs: cap(cronJobs.length),
                personas: cap(personas.length),
            },
            whatsappLinked: waCreds.length > 0,
            storedKeyFingerprint: fp?.value ?? null,
        };
    },
});
/** Delete up to `limit` rows from one table (reaping File-Storage spills
 *  first). Returns the number deleted — the client loops while it equals
 *  `limit`. */
export const resetPage = mutation({
    args: { table: TableName, limit: v.optional(v.number()) },
    handler: async (ctx, args) => {
        const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 500) : 200;
        const rows = await ctx.db.query(args.table).take(limit);
        for (const row of rows) {
            if (STORAGE_SPILL_TABLES.has(args.table)) {
                const storageId = row.storageId;
                if (storageId) {
                    try {
                        await ctx.storage.delete(storageId);
                    }
                    catch {
                        // Already gone — the row delete below still proceeds.
                    }
                }
            }
            await ctx.db.delete(row._id);
        }
        return { deleted: rows.length };
    },
});
//# sourceMappingURL=admin.js.map