import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Short content hash — used as semantic-cache + prompt-fingerprint key. */
export function promptFingerprint(text: string): string {
  return sha256Hex(text.trim().toLowerCase()).slice(0, 32);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}
