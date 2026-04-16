import { redirect } from "next/navigation";

/** Root redirects to PR activity — the primary v1 surface. */
export default function RootPage() {
  redirect("/prs");
}
