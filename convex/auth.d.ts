export declare const listProfiles: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"authProfiles">;
    _creationTime: number;
    alias?: string | undefined;
    metadata?: any;
    keyEnc?: ArrayBuffer | undefined;
    keyRef?: {
        provider: string;
        id: string;
        source: string;
    } | undefined;
    tokenEnc?: ArrayBuffer | undefined;
    tokenRef?: {
        provider: string;
        id: string;
        source: string;
    } | undefined;
    accessEnc?: ArrayBuffer | undefined;
    refreshEnc?: ArrayBuffer | undefined;
    expires?: number | undefined;
    provider: string;
    ownerId: string;
    type: "oauth" | "token" | "api_key";
    profileId: string;
    agentId: string;
    updatedAt: number;
}[]>>;
export declare const getProfile: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
    profileId: string;
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"authProfiles">;
    _creationTime: number;
    alias?: string | undefined;
    metadata?: any;
    keyEnc?: ArrayBuffer | undefined;
    keyRef?: {
        provider: string;
        id: string;
        source: string;
    } | undefined;
    tokenEnc?: ArrayBuffer | undefined;
    tokenRef?: {
        provider: string;
        id: string;
        source: string;
    } | undefined;
    accessEnc?: ArrayBuffer | undefined;
    refreshEnc?: ArrayBuffer | undefined;
    expires?: number | undefined;
    provider: string;
    ownerId: string;
    type: "oauth" | "token" | "api_key";
    profileId: string;
    agentId: string;
    updatedAt: number;
} | null>>;
export declare const upsertProfile: import("convex/server").RegisteredMutation<"public", {
    alias?: string | undefined;
    metadata?: any;
    keyEnc?: ArrayBuffer | undefined;
    keyRef?: {
        provider: string;
        id: string;
        source: string;
    } | undefined;
    tokenEnc?: ArrayBuffer | undefined;
    tokenRef?: {
        provider: string;
        id: string;
        source: string;
    } | undefined;
    accessEnc?: ArrayBuffer | undefined;
    refreshEnc?: ArrayBuffer | undefined;
    expires?: number | undefined;
    provider: string;
    ownerId: string;
    type: "oauth" | "token" | "api_key";
    profileId: string;
    agentId: string;
}, Promise<{
    profileId: string;
    updated: boolean;
}>>;
export declare const deleteProfile: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    profileId: string;
    agentId: string;
}, Promise<{
    deleted: boolean;
}>>;
export declare const loadState: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"profileState">;
    _creationTime: number;
    disabledUntil?: number | undefined;
    cooldownUntil?: number | undefined;
    cooldownModel?: string | undefined;
    errorCount?: number | undefined;
    lastUsed?: number | undefined;
    cooldownReason?: string | undefined;
    disabledReason?: string | undefined;
    failureCounts?: any;
    lastFailureAt?: number | undefined;
    explicitOrder?: number | undefined;
    provider: string;
    ownerId: string;
    profileId: string;
    agentId: string;
    isLastGood: boolean;
}[]>>;
export declare const upsertState: import("convex/server").RegisteredMutation<"public", {
    disabledUntil?: number | undefined;
    cooldownUntil?: number | undefined;
    cooldownModel?: string | undefined;
    errorCount?: number | undefined;
    lastUsed?: number | undefined;
    cooldownReason?: string | undefined;
    disabledReason?: string | undefined;
    failureCounts?: any;
    lastFailureAt?: number | undefined;
    explicitOrder?: number | undefined;
    provider: string;
    ownerId: string;
    profileId: string;
    agentId: string;
    isLastGood: boolean;
}, Promise<{
    profileId: string;
    updated: boolean;
}>>;
//# sourceMappingURL=auth.d.ts.map