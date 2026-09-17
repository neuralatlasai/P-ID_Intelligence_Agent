import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FollowUpComposer } from "@/components/conversation/FollowUpComposer";

/**
 * The composer.
 *
 * Keyboard behaviour is the contract here: Enter sends, Shift+Enter does not, and the
 * control is locked while a run is in flight so a second question cannot be queued behind
 * a guarantee the backend already makes.
 */

function setup(props: Partial<React.ComponentProps<typeof FollowUpComposer>> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <FollowUpComposer onSubmit={onSubmit} onCancel={onCancel} busy={false} {...props} />,
  );
  return { onSubmit, onCancel, user: userEvent.setup() };
}

describe("submission", () => {
  it("sends on Enter", async () => {
    const { onSubmit, user } = setup();
    await user.type(
      screen.getByLabelText(/Ask an engineering question/i),
      "What is FCV-2201?",
    );
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("What is FCV-2201?");
  });

  it("inserts a newline on Shift+Enter without sending", async () => {
    const { onSubmit, user } = setup();
    const field = screen.getByLabelText(/Ask an engineering question/i);
    await user.type(field, "line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(field, "line two");
    expect(onSubmit).not.toHaveBeenCalled();
    expect((field as HTMLTextAreaElement).value).toContain("\n");
  });

  it("sends on the send button", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText(/Ask an engineering question/i), "Question?");
    await user.click(screen.getByRole("button", { name: /send question/i }));
    expect(onSubmit).toHaveBeenCalledWith("Question?");
  });

  it("does not send an empty or whitespace-only draft", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText(/Ask an engineering question/i), "    ");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /send question/i })).toBeDisabled();
  });

  it("trims the submitted text", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText(/Ask an engineering question/i), "  padded  ");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("padded");
  });

  it("clears the field once submission begins", async () => {
    const { user } = setup();
    const field = screen.getByLabelText(/Ask an engineering question/i);
    await user.type(field, "Question?");
    await user.keyboard("{Enter}");
    expect((field as HTMLTextAreaElement).value).toBe("");
  });
});

describe("while a run is active", () => {
  it("offers Stop instead of Send", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send question/i })).toBeNull();
  });

  it("locks the field", () => {
    setup({ busy: true });
    expect(screen.getByLabelText(/Ask an engineering question/i)).toBeDisabled();
  });

  it("cancels on Stop", async () => {
    const { onCancel, user } = setup({ busy: true });
    await user.click(screen.getByRole("button", { name: /stop/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("explains that Stop cancels the analysis", () => {
    setup({ busy: true });
    expect(screen.getByText(/Press Stop to cancel this analysis/i)).toBeInTheDocument();
  });
});

describe("when the backend is unavailable", () => {
  it("blocks submission and says why", async () => {
    const { onSubmit, user } = setup({ blockedReason: "The backend is unavailable." });
    expect(screen.getByLabelText(/Ask an engineering question/i)).toBeDisabled();
    expect(screen.getByText("The backend is unavailable.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("keyboard hint", () => {
  it("states the send and newline keys", () => {
    setup();
    expect(screen.getByText(/Enter to send/)).toBeInTheDocument();
    expect(screen.getByText(/Shift\+Enter/)).toBeInTheDocument();
  });
});
