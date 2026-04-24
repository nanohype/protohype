import { sha256Hex } from "../util/hash.js";

/**
 * Stable fingerprint for a honeypot hit. Hashes sorted header names + UA +
 * content-type + body length bucket so repeated probes from the same tool
 * dedup even across IPs. Excludes fully-variable values so the fingerprint
 * is useful for clustering.
 */
export function fingerprintHit(headers: Record<string, string>, bodyLength: number): string {
  const names = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .filter((k) => !k.startsWith("x-palisade-") && k !== "content-length" && k !== "authorization")
    .sort();
  const ua = headers["user-agent"]?.slice(0, 64) ?? "";
  const contentType = headers["content-type"] ?? "";
  const bucket = bodyLength < 256 ? "S" : bodyLength < 2048 ? "M" : bodyLength < 16_384 ? "L" : "XL";
  return sha256Hex([ua, contentType, bucket, names.join(",")].join("|")).slice(0, 32);
}

const REFUSAL_BANK = [
  "I can't help with that request.",
  "I'm not able to provide that information.",
  "That isn't something I can assist with.",
  "Sorry, I can't share that.",
  "I can't comply with that request.",
];

/** Deterministic refusal based on prompt-hash so a given prompt gets a stable reply. */
export function syntheticRefusal(promptHash: string): string {
  const idx = parseInt(promptHash.slice(0, 2), 16) % REFUSAL_BANK.length;
  return REFUSAL_BANK[idx] ?? REFUSAL_BANK[0]!;
}
