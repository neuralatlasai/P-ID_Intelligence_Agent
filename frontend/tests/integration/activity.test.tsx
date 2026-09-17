import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityDisclosure } from "@/components/conversation/ActivityDisclosure";
import type { ActivityView } from "@/lib/responses/projector";

/**
 * The activity panel.
 *
 * The bound on what may appear here is the point: a tool's name and its state, and nothing
 * else. No reasoning, no tool arguments.
 */

const ACTIVITIES: ActivityView[] = [
  { id: "1", label: "list_corpus_files", state: "complete", startedAt: 0, completedAt: 1 },
  { id: "2", label: "graph_neighbors", state: "running", startedAt: 1 },
];

describe("visibility", () => {
  it("shows nothing when idle with no activity", () => {
    const { container } = render(
      <ActivityDisclosure activities={[]} phase="idle" open={false} onToggle={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a working indicator while a run is active", () => {
    render(
      <ActivityDisclosure activities={[]} phase="connecting" open onToggle={vi.fn()} />,
    );
    expect(screen.getByText("Working...")).toBeInTheDocument();
    expect(screen.getByText(/Connecting to the analysis service/)).toBeInTheDocument();
  });

  it("uses a neutral title once the run is finished", () => {
    render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="completed"
        open
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("Activity & tool calls")).toBeInTheDocument();
  });

  it("reports how many steps were taken", () => {
    render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="completed"
        open
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("2 steps")).toBeInTheDocument();
  });

  it("says when the backend is still persisting the turn", () => {
    render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="finalizing"
        open
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText(/Finalizing session/)).toBeInTheDocument();
  });
});

describe("content", () => {
  it("names each tool and states its status in words", () => {
    render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="completed"
        open
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("list_corpus_files")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("announces status politely rather than as an alert", () => {
    const { container } = render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="streaming"
        open
        onToggle={vi.fn()}
      />,
    );
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector('[aria-live="assertive"]')).toBeNull();
  });
});

describe("controls", () => {
  it("offers Stop while a run is active", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="streaming"
        open
        onToggle={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: /stop/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not offer Stop once the run is finished", () => {
    render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="completed"
        open
        onToggle={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("exposes the expanded state to assistive technology", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ActivityDisclosure
        activities={ACTIVITIES}
        phase="completed"
        open={false}
        onToggle={onToggle}
      />,
    );
    const button = screen.getByRole("button", { name: /Activity & tool calls/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
