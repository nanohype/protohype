import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Auth error — Kiln" };

export default function AuthErrorPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const errorMsg =
    searchParams.error === "AccessDenied"
      ? "Your account does not have access to Kiln. Contact your platform team."
      : "An authentication error occurred. Please try again.";

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4 text-center">
        <AlertTriangle
          className="mx-auto h-10 w-10 text-amber-500"
          aria-hidden
        />
        <h1 className="text-lg font-semibold">Sign-in failed</h1>
        <p className="text-sm text-neutral-500">{errorMsg}</p>
        <Button asChild variant="outline">
          <Link href="/auth/signin">Try again</Link>
        </Button>
      </div>
    </div>
  );
}
