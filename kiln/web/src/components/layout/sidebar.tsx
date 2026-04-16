"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GitPullRequest, Settings, Flame, LogOut } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  {
    href: "/prs",
    label: "Pull Requests",
    icon: GitPullRequest,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-neutral-200 bg-white">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 border-b border-neutral-200 px-4">
        <Flame className="h-5 w-5 text-orange-500" aria-hidden />
        <span className="font-semibold tracking-tight">Kiln</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-4" aria-label="Main navigation">
        <ul className="space-y-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active =
              pathname === href || pathname.startsWith(href + "/");
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-neutral-100 text-neutral-900"
                      : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User */}
      {session?.user && (
        <div className="border-t border-neutral-200 p-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium">
              {session.user.name?.charAt(0).toUpperCase() ?? "?"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-neutral-900">
                {session.user.name}
              </p>
              <p className="truncate text-xs text-neutral-500">
                {session.user.email}
              </p>
            </div>
            <button
              onClick={() => signOut()}
              className="shrink-0 rounded p-1 text-neutral-400 hover:text-neutral-600"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
