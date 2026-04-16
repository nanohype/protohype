import { signIn } from "next-auth/react";
import SignInClient from "./sign-in-client";

export const metadata = {
  title: "Sign in — Kiln",
};

export default function SignInPage() {
  return <SignInClient />;
}
