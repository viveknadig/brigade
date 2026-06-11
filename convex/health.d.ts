export declare const ping: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    ok: boolean;
    schemaVersion: number;
    hasConfig: boolean;
    now: number;
}>>;
export declare const getMeta: import("convex/server").RegisteredQuery<"public", {
    key: string;
}, Promise<string | null>>;
export declare const setMeta: import("convex/server").RegisteredMutation<"public", {
    value: string;
    key: string;
}, Promise<{
    updated: boolean;
}>>;
//# sourceMappingURL=health.d.ts.map