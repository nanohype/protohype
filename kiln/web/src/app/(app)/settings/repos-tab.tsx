"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, GitBranch } from "lucide-react";
import { getTeamConfig, addWatchedRepo, removeWatchedRepo } from "@/lib/api";
import { AddRepoSchema } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

function AddRepoForm({
  teamId,
  token,
  onSuccess,
}: {
  teamId: string;
  token: string;
  onSuccess: () => void;
}) {
  const [newRepo, setNewRepo] = useState("");
  const [newInstId, setNewInstId] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const addMut = useMutation({
    mutationFn: (vars: {
      fullName: string;
      installationId: number;
      defaultBranch: string;
    }) => addWatchedRepo(teamId, vars, token),
    onSuccess: () => {
      onSuccess();
      setNewRepo("");
      setNewInstId("");
      setValidationError(null);
    },
    onError: (e: Error) => setValidationError(e.message),
  });

  function handleAdd() {
    const parsed = AddRepoSchema.safeParse({
      fullName: newRepo.trim(),
      installationId: Number(newInstId),
      defaultBranch: "main",
    });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setValidationError(null);
    addMut.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add repository</CardTitle>
        <CardDescription>
          Connect a GitHub repo to Kiln. The GitHub App must already be
          installed on the target org.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="repo-name">Repository (owner/repo)</Label>
          <Input
            id="repo-name"
            placeholder="acme/my-app"
            value={newRepo}
            onChange={(e) => setNewRepo(e.target.value)}
            aria-describedby={validationError ? "repo-error" : undefined}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="inst-id">GitHub App Installation ID</Label>
          <Input
            id="inst-id"
            type="number"
            placeholder="12345678"
            value={newInstId}
            onChange={(e) => setNewInstId(e.target.value)}
          />
        </div>
        {validationError && (
          <p id="repo-error" className="text-xs text-red-600" role="alert">
            {validationError}
          </p>
        )}
        <Button
          onClick={handleAdd}
          disabled={addMut.isPending || !newRepo || !newInstId}
          size="sm"
        >
          <Plus className="h-4 w-4" />
          Add repository
        </Button>
      </CardContent>
    </Card>
  );
}

function WatchedReposList({
  config,
  teamId,
  token,
  onChanged,
}: {
  config: TeamConfig;
  teamId: string;
  token: string;
  onChanged: () => void;
}) {
  const removeMut = useMutation({
    mutationFn: (fullName: string) =>
      removeWatchedRepo(teamId, fullName, token),
    onSuccess: onChanged,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Watched repositories</CardTitle>
        <CardDescription>
          Kiln polls these repos for dependency upgrades.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {config.watchedRepos.length === 0 && (
          <p className="text-sm text-neutral-500">
            No repositories added yet.
          </p>
        )}
        {config.watchedRepos.length > 0 && (
          <ul className="divide-y divide-neutral-100" role="list">
            {config.watchedRepos.map((repo) => (
              <li
                key={repo.fullName}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <GitBranch className="h-4 w-4 shrink-0 text-neutral-400" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {repo.fullName}
                    </p>
                    <p className="text-xs text-neutral-500">
                      branch: {repo.defaultBranch}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <Switch
                      id={`enabled-${repo.fullName}`}
                      checked={repo.enabled}
                      aria-label={`${repo.enabled ? "Disable" : "Enable"} ${repo.fullName}`}
                      disabled
                    />
                    <Label
                      htmlFor={`enabled-${repo.fullName}`}
                      className="text-xs text-neutral-500"
                    >
                      {repo.enabled ? "Active" : "Paused"}
                    </Label>
                  </div>
                  <button
                    onClick={() => removeMut.mutate(repo.fullName)}
                    disabled={removeMut.isPending}
                    className="text-neutral-400 hover:text-red-500 disabled:opacity-50"
                    aria-label={`Remove ${repo.fullName}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function ReposTab() {
  const { data: session } = useSession();
  const teamId = useTeamId(session);
  const token = useToken(session);
  const qc = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ["team-config", teamId],
    queryFn: () => getTeamConfig(teamId, token ?? ""),
    enabled: !!teamId && !!token,
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["team-config", teamId] });
  }

  return (
    <div className="space-y-6">
      {teamId && token && (
        <AddRepoForm teamId={teamId} token={token} onSuccess={invalidate} />
      )}

      {isLoading && (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-neutral-100" />
          ))}
        </div>
      )}

      {config && token && (
        <WatchedReposList
          config={config}
          teamId={teamId}
          token={token}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}
