"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { getTeamConfig, updateTeamConfig } from "@/lib/api";
import { GroupingSettingsSchema } from "@/lib/schemas";
import { groupingStrategyLabel } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import type { GroupingStrategy, DepFamilyPattern, TeamConfig } from "@/types";

const STRATEGIES: GroupingStrategy[] = [
  "per-dep",
  "per-family",
  "per-release-window",
];

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
function GroupingForm({
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
  const [strategy, setStrategy] = useState<GroupingStrategy>(
    config.groupingStrategy
  );
  const [patterns, setPatterns] = useState<DepFamilyPattern[]>(
    config.familyPatterns
  );
  const [cron, setCron] = useState(config.releaseWindowCron ?? "");
  const [newPattern, setNewPattern] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const saveMut = useMutation({
    mutationFn: () =>
      updateTeamConfig(
        teamId,
        {
          groupingStrategy: strategy,
          familyPatterns: patterns,
          releaseWindowCron: cron || undefined,
        },
        token
      ),
    onSuccess: () => {
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (e: Error) => setError(e.message),
  });

  function handleSave() {
    const result = GroupingSettingsSchema.safeParse({
      groupingStrategy: strategy,
      familyPatterns: patterns,
      releaseWindowCron: cron || undefined,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid configuration");
      return;
    }
    setError(null);
    saveMut.mutate();
  }

  function addPattern() {
    if (!newPattern.trim() || !newLabel.trim()) return;
    setPatterns((prev) => [
      ...prev,
      { pattern: newPattern.trim(), label: newLabel.trim() },
    ]);
    setNewPattern("");
    setNewLabel("");
  }

  function removePattern(index: number) {
    setPatterns((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>PR grouping strategy</CardTitle>
        <CardDescription>
          Mirrors Renovate&apos;s groupName config — teams with existing grouping
          preferences migrate in place.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-2">
          <Label htmlFor="strategy">Grouping strategy</Label>
          <Select
            value={strategy}
            onValueChange={(v) => setStrategy(v as GroupingStrategy)}
          >
            <SelectTrigger id="strategy" className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {groupingStrategyLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-neutral-500">
            {strategy === "per-dep" &&
              "One PR per dependency. Simplest — best for small teams or low-volume repos."}
            {strategy === "per-family" &&
              "One PR per package family (e.g. all @aws-sdk/* in a single PR). Define family patterns below."}
            {strategy === "per-release-window" &&
              "Batch all upgrades into a single PR on a schedule. Define the window cron below."}
          </p>
        </div>

        {strategy === "per-family" && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Family patterns</p>
            {patterns.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <code className="flex-1 rounded bg-neutral-100 px-2 py-1 text-xs">
                  {p.pattern}
                </code>
                <span className="text-xs text-neutral-500">{p.label}</span>
                <button
                  onClick={() => removePattern(i)}
                  className="text-neutral-400 hover:text-red-500"
                  aria-label={`Remove pattern ${p.pattern}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                placeholder="@aws-sdk/*"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                className="w-48 font-mono text-xs"
                aria-label="New family pattern"
              />
              <Input
                placeholder="AWS SDK"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="w-32"
                aria-label="Family label"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={addPattern}
                disabled={!newPattern || !newLabel}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {strategy === "per-release-window" && (
          <div className="grid gap-2">
            <Label htmlFor="cron">Release window (cron)</Label>
            <Input
              id="cron"
              className="w-64 font-mono"
              placeholder="0 9 * * 1"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
            <p className="text-xs text-neutral-500">
              UTC cron expression. Example: &quot;0 9 * * 1&quot; = every Monday
              9am UTC.
            </p>
          </div>
        )}

        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            onClick={handleSave}
            disabled={saveMut.isPending}
            size="sm"
          >
            {saveMut.isPending ? "Saving…" : "Save grouping settings"}
          </Button>
          {saved && <span className="text-xs text-green-600">Saved ✓</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export function GroupingTab() {
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
    return (
      <div className="h-48 animate-pulse rounded-lg bg-neutral-100" />
    );
  }

  return (
    <GroupingForm
      // key forces form to re-initialize when config identity changes
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
