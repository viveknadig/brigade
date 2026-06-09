export declare const read: import("convex/server").RegisteredQuery<"public", {
    instanceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"brigadeConfig">;
    _creationTime: number;
    agents?: any;
    skills?: any;
    defaults?: any;
    gateway?: any;
    session?: any;
    tools?: any;
    auth?: any;
    plugins?: any;
    wizard?: any;
    meta?: any;
    bindings?: any;
    org?: any;
    encryptedGatewayAuthToken?: ArrayBuffer | undefined;
    encryptedGatewayAuthPassword?: ArrayBuffer | undefined;
    updatedByPid?: number | undefined;
    bytes: number;
    updatedAtMs: number;
    instanceId: string;
    schemaVersion: 2;
    contentSha256: string;
} | null>>;
export declare const write: import("convex/server").RegisteredMutation<"public", {
    agents?: any;
    skills?: any;
    defaults?: any;
    gateway?: any;
    session?: any;
    tools?: any;
    auth?: any;
    plugins?: any;
    wizard?: any;
    meta?: any;
    bindings?: any;
    org?: any;
    expectedSha256?: string | undefined;
    bytes: number;
    instanceId: string;
    contentSha256: string;
}, Promise<{
    rev: string;
    updated: boolean;
}>>;
//# sourceMappingURL=config.d.ts.map