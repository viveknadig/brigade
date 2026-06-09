export declare const listAccess: import("convex/server").RegisteredQuery<"public", {
    kind: "pairing" | "allow-from" | "group-allow-from";
    ownerId: string;
    accountId: string;
    channelId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"channelAccess">;
    _creationTime: number;
    code?: ArrayBuffer | undefined;
    senderName?: string | undefined;
    createdAt?: number | undefined;
    lastSeenAt?: number | undefined;
    kind: "pairing" | "allow-from" | "group-allow-from";
    ownerId: string;
    accountId: string;
    channelId: string;
    senderId: ArrayBuffer;
}[]>>;
export declare const upsertAccess: import("convex/server").RegisteredMutation<"public", {
    code?: ArrayBuffer | undefined;
    senderName?: string | undefined;
    kind: "pairing" | "allow-from" | "group-allow-from";
    ownerId: string;
    accountId: string;
    channelId: string;
    senderId: ArrayBuffer;
}, Promise<{
    changed: boolean;
}>>;
export declare const removeAccess: import("convex/server").RegisteredMutation<"public", {
    kind: "pairing" | "allow-from" | "group-allow-from";
    ownerId: string;
    accountId: string;
    channelId: string;
    senderId: ArrayBuffer;
}, Promise<boolean>>;
export declare const eraseAccount: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    accountId: string;
    channelId: string;
}, Promise<void>>;
export declare const upsertPairingRequest: import("convex/server").RegisteredMutation<"public", {
    senderName?: string | undefined;
    ownerId: string;
    accountId: string;
    channelId: string;
    senderId: ArrayBuffer;
}, Promise<{
    code: string;
    isNew: boolean;
}>>;
export declare const approvePairing: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    code: string;
    accountId: string;
    channelId: string;
}, Promise<{
    code: string;
    senderId: string;
    senderName: string | null;
} | null>>;
export declare const revokePairing: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    code: string;
    accountId: string;
    channelId: string;
}, Promise<boolean>>;
export declare const writeAuthFile: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    accountId: string;
    fileKey: string;
    contentB64: ArrayBuffer;
}, Promise<void>>;
export declare const readAuthFile: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
    accountId: string;
    fileKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"whatsappAuthFile">;
    _creationTime: number;
    ownerId: string;
    accountId: string;
    updatedAt: number;
    fileKey: string;
    contentB64: ArrayBuffer;
    contentVersion: number;
} | null>>;
//# sourceMappingURL=channels.d.ts.map