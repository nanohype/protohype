"use client";

import { signIn } from "next-auth/react";
import { Flame, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Okta SSO sign-in page. Identity is resolved via Okta OIDC + SCIM — not a username/password form. */
export default function SignInClient() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-orange-500 text-white">
            <Flame className="h-6 w-6" aria-hidden />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold">Sign in to Kiln</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Dependency upgrade automation for your team
            </p>
          </div>
        </div>

        {/* SSO button */}
        <Button
          className="w-full gap-2"
          onClick={() => signIn("okta", { callbackUrl: "/prs" })}
        >
          Continue with Okta SSO
          <ArrowRight className="h-4 w-4" />
        </Button>

        <p className="text-center text-xs text-neutral-400">
          Team membership is resolved from your Okta groups.
          <br />
          Contact your platform team to request access.
        </p>
      </div>
    </div>
  );
}
