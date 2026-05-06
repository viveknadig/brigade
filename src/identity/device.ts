import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { ensureDir, resolveIdentityDir } from "../config/paths.js";

// Ed25519 device identity for the host running brigade. The public key is
// the stable identifier the future gateway and any paired native client
// will use to recognise this machine; the private key signs connection
// payloads. Generated once on first onboard, persisted at mode 0600,
// re-read thereafter.
//
// The format is intentionally simple — three fields per file, JSON, no
// PEM wrappers — because brigade's only consumers are brigade itself and
// future brigade-aware clients. If interop with external tooling becomes
// a requirement we can add a PEM emitter at that point.

const DEVICE_FILE = "device.json";
const DEVICE_AUTH_FILE = "device-auth.json";
const SCHEMA_VERSION = 1;

export interface DeviceIdentity {
  version: number;
  // Stable per-host UUID. Survives key rotations.
  deviceId: string;
  // Human-readable label (defaults to the OS hostname). User can edit.
  label: string;
  // Ed25519 public key, base64. Safe to share.
  publicKey: string;
  createdAt: string;
}

export interface DeviceAuth {
  version: number;
  deviceId: string;
  // Ed25519 private key, base64. Mode 0600. Never logged, never sent.
  privateKey: string;
  createdAt: string;
}

export interface EnsureDeviceResult {
  identity: DeviceIdentity;
  created: boolean;
}

// Generate the keypair on first call; on subsequent calls return the
// existing identity. Idempotent across re-onboard runs.
export async function ensureDeviceIdentity(): Promise<EnsureDeviceResult> {
  const dir = resolveIdentityDir();
  ensureDir(dir);

  const identityPath = path.join(dir, DEVICE_FILE);
  const authPath = path.join(dir, DEVICE_AUTH_FILE);

  const existing = await tryReadIdentity(identityPath);
  if (existing) return { identity: existing, created: false };

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const label = safeHostName();
  const createdAt = new Date().toISOString();

  const identity: DeviceIdentity = {
    version: SCHEMA_VERSION,
    deviceId,
    label,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    createdAt,
  };
  const auth: DeviceAuth = {
    version: SCHEMA_VERSION,
    deviceId,
    privateKey: privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
    createdAt,
  };

  await writeJsonAtomic(identityPath, identity, 0o644);
  await writeJsonAtomic(authPath, auth, 0o600);

  return { identity, created: true };
}

async function tryReadIdentity(p: string): Promise<DeviceIdentity | undefined> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as DeviceIdentity;
    if (typeof parsed?.deviceId !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  mode: number,
): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode,
  });
  if (process.platform !== "win32") {
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // Some FSs (FAT32, network mounts) reject chmod — best effort.
    }
  }
  await fs.rename(tmp, filePath);
}

function safeHostName(): string {
  try {
    return os.hostname();
  } catch {
    return "brigade-host";
  }
}
