import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PRStatusBadge } from "./pr-status-badge";

describe("PRStatusBadge", () => {
  it("renders 'Open' for open status", () => {
    render(<PRStatusBadge status="open" />);
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("renders 'Merged' for merged status", () => {
    render(<PRStatusBadge status="merged" />);
    expect(screen.getByText("Merged")).toBeInTheDocument();
  });

  it("renders 'Needs review' for flagged status", () => {
    render(<PRStatusBadge status="flagged_needs_human" />);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it("renders 'Closed' for closed status", () => {
    render(<PRStatusBadge status="closed" />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });
});
