import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnswerRenderer } from "@/components/conversation/AnswerRenderer";

import { FULL_ANSWER, PLAIN_ANSWER } from "../fixtures/answers";

/**
 * The answer surface.
 *
 * Model output is untrusted, so the security assertions here are the important ones: no
 * script executes, no unsafe URL becomes a link, and no content is lost when the projector
 * fails to recognise structure.
 */

describe("rendering", () => {
  it("renders the whole answer", () => {
    render(<AnswerRenderer text={FULL_ANSWER} />);
    expect(screen.getByText(/regulating flow to heat exchanger/)).toBeInTheDocument();
    expect(screen.getByText(/Alarm configuration was not found/)).toBeInTheDocument();
  });

  it("labels the evidence classifications as headings", () => {
    render(<AnswerRenderer text={FULL_ANSWER} />);
    expect(screen.getByRole("heading", { name: /Observed/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Corroborated/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Inferred/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Conflicting/ })).toBeInTheDocument();
  });

  it("renders an unstructured answer without losing anything", () => {
    render(<AnswerRenderer text={PLAIN_ANSWER} />);
    expect(screen.getByText(/cooling water circuit/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing in the corpus states the design pressure/),
    ).toBeInTheDocument();
  });

  it("renders GFM tables inside a scrollable container", () => {
    const table = ["| Tag | Type |", "| --- | --- |", "| FCV-2201 | Valve |"].join("\n");
    render(<AnswerRenderer text={table} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /scrollable/i })).toBeInTheDocument();
  });

  it("renders nothing for empty text", () => {
    const { container } = render(<AnswerRenderer text="" />);
    expect(container.textContent).toBe("");
  });
});

describe("untrusted content", () => {
  it("does not execute embedded HTML", () => {
    const hostile =
      "Answer\n<script>window.__pwned = true;</script>\n<img src=x onerror=alert(1)>";
    const { container } = render(<AnswerRenderer text={hostile} />);
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
  });

  it("does not render a javascript: link as a link", () => {
    render(<AnswerRenderer text="See [the spec](javascript:alert(1))." />);
    expect(screen.queryByRole("link")).toBeNull();
    // The text is kept: dropping it would silently remove content the answer contained.
    expect(screen.getByText(/the spec/)).toBeInTheDocument();
  });

  it("does not render a data: link as a link", () => {
    render(<AnswerRenderer text="[x](data:text/html,<script>alert(1)</script>)" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("opens an external link with safe rel attributes", () => {
    render(<AnswerRenderer text="[spec](https://example.com/spec)" />);
    const link = screen.getByRole("link", { name: "spec" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("does not turn a corpus path into a broken image", () => {
    render(<AnswerRenderer text="![PID drawing](area_100/PID-100.png)" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("PID drawing")).toBeInTheDocument();
  });

  it("survives malformed markdown without throwing", () => {
    expect(() =>
      render(<AnswerRenderer text={"Answer\n| a | b\n| --- \n**unclosed"} />),
    ).not.toThrow();
  });
});

describe("streaming and partial output", () => {
  it("labels a partial response as incomplete", () => {
    render(<AnswerRenderer text="Half an ans" partial />);
    expect(screen.getByText(/Partial response/)).toBeInTheDocument();
    expect(screen.getByText(/not a finished engineering answer/)).toBeInTheDocument();
  });

  it("does not label a completed response as partial", () => {
    render(<AnswerRenderer text="A complete answer." />);
    expect(screen.queryByText(/Partial response/)).toBeNull();
  });
});
