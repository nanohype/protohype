import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Env vars are accessed at runtime via process.env.
  // NEXT_PUBLIC_* vars are inlined into the browser bundle by Next.js.
  // All other env vars (NEXTAUTH_SECRET, OKTA_*, KILN_API_KEY) remain
  // server-only and are never exposed to the client.
};

export default nextConfig;
