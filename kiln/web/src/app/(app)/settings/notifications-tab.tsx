"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getTeamConfig, updateTeamConfig } from "@/lib/api";
import { NotificationSettingsSchema } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

/** Inner form that initializes state from the loaded config prop — no useEffect needed. */
function NotificationsForm({
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
  const [channelId, setChannelId] = useState(config.slackChannelId ?? "");
  const [slaDays, setSlaDays] = useState(config.reviewSlaDays);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const saveMut = useMutation({
    mutationFn: () =>
      updateTeamConfig(
        teamId,
        {
          slackChannelId: channelId || undefined,
          reviewSlaDays: slaDays,
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
    const result = NotificationSettingsSchema.safeParse({
      slackChannelId: channelId,
      reviewSlaDays: slaDays,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setError(null);
    saveMut.mutate();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Kiln pings your Slack channel when a PR opens and when it exceeds the
          review SLA.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2">
          <Label htmlFor="slack-channel">Slack channel ID</Label>
          <Input
            id="slack-channel"
            placeholder="C01234ABCDE"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="w-48 font-mono"
            aria-describedby="channel-hint"
          />
          <p id="channel-hint" className="text-xs text-neutral-500">
            Channel ID (starts with C), not the channel name. Find it in Slack
            → channel settings.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="sla-days">Review SLA (days)</Label>
          <Input
            id="sla-days"
            type="number"
            min={1}
            max={90}
            value={slaDays}
            onChange={(e) => setSlaDays(Number(e.target.value))}
            className="w-24"
            aria-describedby="sla-hint"
          />
          <p id="sla-hint" className="text-xs text-neutral-500">
            Kiln sends a Slack reminder if a PR hasn&apos;t been reviewed within
            this many days. Success target: ≤7 days.
          </p>
        </div>

        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={saveMut.isPending} size="sm">
            {saveMut.isPending ? "Saving…" : "Save notifications"}
          </Button>
          {saved && <span className="text-xs text-green-600">Saved ✓</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export function NotificationsTab() {
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
    <NotificationsForm
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
