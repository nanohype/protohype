import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BreakingChangeItem } from "./breaking-change-item";
import type { BreakingChange } from "@/types";

const PATCHED_CHANGE: BreakingChange = {
  description: "createRoot API changed",
  resolution: "patched",
  filePath: "src/index.tsx",
  lineRange: { start: 5, end: 7 },
  changelogUrl: "https://react.dev/blog/2024/04/25/react-19#new-root-api",
  patchNote: "Updated ReactDOM.render to createRoot",
};

const FLAGGED_CHANGE: BreakingChange = {
  description: "Legacy context API removed",
  resolution: "flagged",
  filePath: "src/components/Provider.tsx",
  lineRange: { start: 12, end: 20 },
  changelogUrl: "https://react.dev/blog/2024/04/25/react-19#removed-legacy-context",
  patchNote: "Manual migration required — uses dynamic context keys",
};

describe("BreakingChangeItem", () => {
  it("shows description text", () => {
    render(<BreakingChangeItem change={PATCHED_CHANGE} />);
    expect(screen.getByText("createRoot API changed")).toBeInTheDocument();
  });

  it("shows file:line range", () => {
    render(<BreakingChangeItem change={PATCHED_CHANGE} />);
    expect(screen.getByText(/src\/index\.tsx/)).toBeInTheDocument();
    expect(screen.getByText(/5.+7/)).toBeInTheDocument();
  });

  it("renders changelog link", () => {
    render(<BreakingChangeItem change={PATCHED_CHANGE} />);
    const link = screen.getByRole("link", { name: /changelog/i });
    expect(link).toHaveAttribute(
      "href",
      "https://react.dev/blog/2024/04/25/react-19#new-root-api"
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows patched icon for resolved:patched", () => {
    render(<BreakingChangeItem change={PATCHED_CHANGE} />);
    expect(screen.getByLabelText("Patched by Kiln")).toBeInTheDocument();
  });

  it("shows warning icon for resolution:flagged", () => {
    render(<BreakingChangeItem change={FLAGGED_CHANGE} />);
    expect(screen.getByLabelText("Needs human review")).toBeInTheDocument();
  });

  it("shows patch note text", () => {
    render(<BreakingChangeItem change={PATCHED_CHANGE} />);
    expect(
      screen.getByText("Updated ReactDOM.render to createRoot")
    ).toBeInTheDocument();
  });
});
