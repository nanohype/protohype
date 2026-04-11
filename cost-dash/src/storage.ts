/**
 * Storage abstraction for perf data.
 *
 * In production (PERF_BUCKET set): reads/writes to S3.
 * In development (no PERF_BUCKET): falls back to local file.
 */

import fs from "node:fs/promises";
import path from "node:path";

function isS3Configured(): boolean {
  return !!process.env.PERF_BUCKET;
}

function getBucket(): string {
  return process.env.PERF_BUCKET!;
}

function getKey(): string {
  return process.env.PERF_KEY ?? "perf.json";
}

function getLocalPath(): string {
  return process.env.PERF_FILE ?? path.join(process.cwd(), ".perf.json");
}

// Lazy-init S3 client to avoid importing AWS SDK in dev
let _s3: import("@aws-sdk/client-s3").S3Client | null = null;
async function getS3() {
  if (!_s3) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    _s3 = new S3Client({});
  }
  return _s3;
}

export async function readPerfData(): Promise<string | null> {
  if (isS3Configured()) {
    const s3 = await getS3();
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const res = await s3.send(new GetObjectCommand({
        Bucket: getBucket(),
        Key: getKey(),
      }));
      return await res.Body!.transformToString("utf-8");
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  // Local file fallback
  try {
    return await fs.readFile(getLocalPath(), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writePerfData(json: string): Promise<void> {
  if (isS3Configured()) {
    const s3 = await getS3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new PutObjectCommand({
      Bucket: getBucket(),
      Key: getKey(),
      Body: json,
      ContentType: "application/json",
    }));
    return;
  }

  // Local file fallback — atomic write via tmp + rename
  const filePath = getLocalPath();
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, filePath);
}
