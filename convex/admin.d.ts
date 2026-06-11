declare const RESETTABLE_TABLES: readonly ["brigadeConfig", "brigadeConfigAudit", "brigadeConfigBackups", "configHealth", "personaFiles", "workspaceState", "memoryFacts", "memoryExtractCursors", "memoryConsolidateState", "sessions", "sessionTranscriptRecords", "sessionInboxEvents", "sessionEvents", "subsystemLog", "cronJobs", "cronRuns", "cronServiceState", "channelAccess", "whatsappAuthFile", "channelMediaBlob", "authProfiles", "profileState", "authFiles", "systemMeta", "whatsappAuthCreds", "whatsappAuthKeys", "execApprovals", "skills", "extensions", "orgDeriveAudit", "orgChartCache", "subagentRuns", "gatewayCoord", "brigadeBlobs"];
export type ResettableTable = (typeof RESETTABLE_TABLES)[number];
/** The list the reset client iterates — exported via query so the CLI and
 *  the server can never drift on which tables exist. */
export declare const listResettableTables: import("convex/server").RegisteredQuery<"public", {}, Promise<("extensions" | "sessions" | "skills" | "brigadeConfig" | "brigadeConfigAudit" | "brigadeConfigBackups" | "configHealth" | "personaFiles" | "workspaceState" | "memoryFacts" | "memoryExtractCursors" | "memoryConsolidateState" | "sessionTranscriptRecords" | "sessionInboxEvents" | "sessionEvents" | "subsystemLog" | "cronJobs" | "cronRuns" | "cronServiceState" | "channelAccess" | "whatsappAuthFile" | "channelMediaBlob" | "authProfiles" | "profileState" | "authFiles" | "systemMeta" | "whatsappAuthCreds" | "whatsappAuthKeys" | "execApprovals" | "orgDeriveAudit" | "orgChartCache" | "subagentRuns" | "gatewayCoord" | "brigadeBlobs")[]>>;
/** Headline summary for "found an existing Brigade in this backend". */
export declare const instanceSummary: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    hasData: boolean;
    createdAtMs: number | null;
    counts: {
        memories: number;
        sessions: number;
        cronJobs: number;
        personas: number;
    };
    whatsappLinked: boolean;
    storedKeyFingerprint: string | null;
}>>;
/** Delete up to `limit` rows from one table (reaping File-Storage spills
 *  first). Returns the number deleted — the client loops while it equals
 *  `limit`. */
export declare const resetPage: import("convex/server").RegisteredMutation<"public", {
    limit?: number | undefined;
    table: "extensions" | "sessions" | "skills" | "brigadeConfig" | "brigadeConfigAudit" | "brigadeConfigBackups" | "configHealth" | "personaFiles" | "workspaceState" | "memoryFacts" | "memoryExtractCursors" | "memoryConsolidateState" | "sessionTranscriptRecords" | "sessionInboxEvents" | "sessionEvents" | "subsystemLog" | "cronJobs" | "cronRuns" | "cronServiceState" | "channelAccess" | "whatsappAuthFile" | "channelMediaBlob" | "authProfiles" | "profileState" | "authFiles" | "systemMeta" | "whatsappAuthCreds" | "whatsappAuthKeys" | "execApprovals" | "orgDeriveAudit" | "orgChartCache" | "subagentRuns" | "gatewayCoord" | "brigadeBlobs";
}, Promise<{
    deleted: number;
}>>;
export {};
//# sourceMappingURL=admin.d.ts.map