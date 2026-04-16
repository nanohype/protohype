"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Plus } from "lucide-react";
import { getTeamConfig, updateTeamConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import type { TeamConfig } from "@/types";

function useTeamId(session: ReturnType<typeof useSession>["data"]) {
  return (
    ((session?.user as Record<string, unknown> | undefined)
      ?.teamIds as string[]) ?? []
  )[0];
}
function useToken(session: ReturnType<typeof useSession>["data"]) {
  return (session as Record<string, unknown> | null)?.accessToken as
    | string
    | undefined;
}

/** Inner form that initializes state directly from the loaded config prop. */
function SkipListForm({
  config,
  teamId,
  token,
  onSaved,
}: {
  config: TeamConfig;
  teamId: string;
  token: string;
  onSaved: () => void;
}) {
  const [skipList, setSkipList] = useState<string[]>(config.skipList);
  const [newEntry, setNewEntry] = useState("");
  const [saved, setSaved] = useState(false);

  const saveMut = useMutation({
    mutationFn: () => updateTeamConfig(teamId, { skipList }, token),
    onSuccess: () => {
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function addEntry() {
    const trimmed = newEntry.trim();
    if (!trimmed || skipList.includes(trimmed)) return;
    setSkipList((prev) => [...prev, trimmed]);
    setNewEntry("");
  }

  function removeEntry(entry: string) {
    setSkipList((prev) => prev.filter((e) => e !== entry));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Skip list</CardTitle>
        <CardDescription>
          Packages on this list are never upgraded by Kiln. Supports exact names
          (react) and globs (lodash.*).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="flex min-h-[2.5rem] flex-wrap gap-2 rounded-md border border-neutral-200 p-2"
          aria-label="Skip list entries"
        >
          {skipList.length === 0 && (
            <span className="text-xs text-neutral-400">
              No packages on the skip list.
            </span>
          )}
          {skipList.map((entry) => (
            <Badge
              key={entry}
              variant="secondary"
              className="gap-1 font-mono text-xs"
            >
              {entry}
              <button
                onClick={() => removeEntry(entry)}
                className="ml-1 rounded hover:text-neutral-900"
                aria-label={`Remove ${entry} from skip list`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="react or lodash.*"
            value={newEntry}
            onChange={(e) => setNewEntry(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addEntry()}
            className="w-64 font-mono text-sm"
            aria-label="New skip list entry"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={addEntry}
            disabled={!newEntry.trim()}
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            size="sm"
          >
            {saveMut.isPending ? "Saving…" : "Save skip list"}
          </Button>
          {saved && <span className="text-xs text-green-600">Saved ✓</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export function SkipListTab() {
  const { data: session } = useSession();
  const teamId = useTeamId(session);
  const token = useToken(session);
  const qc = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ["team-config", teamId],
    queryFn: () => getTeamConfig(teamId, token ?? ""),
    enabled: !!teamId && !!token,
  });

  if (isLoading || !config || !token) {
    return <div className="h-48 animate-pulse rounded-lg bg-neutral-100" />;
  }

  return (
    <SkipListForm
      key={config.updatedAt}
      config={config}
      teamId={teamId}
      token={token}
      onSaved={() =>
        qc.invalidateQueries({ queryKey: ["team-config", teamId] })
      }
    />
  );
}
