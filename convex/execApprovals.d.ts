export declare const list: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"execApprovals">;
    _creationTime: number;
    kind: "exact" | "pattern";
    ownerId: string;
    value: string;
    agentId: string;
    createdAt: number;
    valueNormalised: string;
}[]>>;
export declare const insert: import("convex/server").RegisteredMutation<"public", {
    kind: "exact" | "pattern";
    ownerId: string;
    value: string;
    agentId: string;
    valueNormalised: string;
}, Promise<{
    inserted: boolean;
}>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    agentId: string;
    valueNormalised: string;
}, Promise<{
    removedCommands: number;
    removedPatterns: number;
}>>;
//# sourceMappingURL=execApprovals.d.ts.map