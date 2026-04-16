import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MetricsStrip } from "./metrics-strip";
import type { TeamMetrics } from "@/types";

const GOOD_METRICS: TeamMetrics = {
  teamId: "team-1",
  medianMergeDays: 4,
  releaseTriggeredPct: 95,
  openPrCount: 3,
  mergedPrCount: 18,
  flaggedPrCount: 0,
  windowDays: 30,
};

const BAD_METRICS: TeamMetrics = {
  teamId: "team-1",
  medianMergeDays: 14,
  releaseTriggeredPct: 70,
  openPrCount: 5,
  mergedPrCount: 10,
  flaggedPrCount: 2,
  windowDays: 30,
};

const NULL_METRICS: TeamMetrics = {
  teamId: "team-1",
  medianMergeDays: null,
  releaseTriggeredPct: null,
  openPrCount: 0,
  mergedPrCount: 0,
  flaggedPrCount: 0,
  windowDays: 30,
};

describe("MetricsStrip", () => {
  it("renders median merge days", () => {
    render(<MetricsStrip metrics={GOOD_METRICS} />);
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders release coverage as percentage", () => {
    render(<MetricsStrip metrics={GOOD_METRICS} />);
    expect(screen.getByText("95%")).toBeInTheDocument();
  });

  it("renders dash when median is null", () => {
    render(<MetricsStrip metrics={NULL_METRICS} />);
    // Two "—" values (median + coverage)
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("shows 30-day window label", () => {
    render(<MetricsStrip metrics={GOOD_METRICS} />);
    expect(screen.getByText("Last 30 days")).toBeInTheDocument();
  });

  it("renders flagged PR count", () => {
    render(<MetricsStrip metrics={BAD_METRICS} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
