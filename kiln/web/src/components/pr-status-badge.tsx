import { Badge } from "@/components/ui/badge";
import type { KilnPRStatus } from "@/types";

interface PRStatusBadgeProps {
  status: KilnPRStatus;
}

const STATUS_CONFIG: Record<
  KilnPRStatus,
  { label: string; variant: "success" | "purple" | "secondary" | "destructive" }
> = {
  open: { label: "Open", variant: "success" },
  merged: { label: "Merged", variant: "purple" },
  closed: { label: "Closed", variant: "secondary" },
  flagged_needs_human: { label: "Needs review", variant: "destructive" },
};

export function PRStatusBadge({ status }: PRStatusBadgeProps) {
  const cfg = STATUS_CONFIG[status] ?? {
    label: status,
    variant: "secondary" as const,
  };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
