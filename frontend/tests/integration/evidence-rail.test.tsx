import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EvidenceRail } from "@/components/evidence/EvidenceRail";

import { CONFLICTING_ANSWER, FULL_ANSWER, PLAIN_ANSWER } from "../fixtures/answers";

/**
 * The evidence rail.
 *
 * Every card is conditional on the answer explicitly containing the corresponding content.
 * The assertions that matter are the negative ones: an absent section produces no card,
 * because a placeholder saying "no topology change" would be a claim the answer never made.
 */

describe("cards appear only for explicit content", () => {
  it("renders every card when the answer contains every section", () => {
    render(
      <EvidenceRail answer={FULL_ANSWER} toolPaths={["PID2Graph OPEN100/0.graphml"]} />,
    );
    expect(screen.getByRole("heading", { name: /Cited drawings/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Evidence support/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Topology/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Asset hierarchy/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /impacted assets/i })).toBeInTheDocument();
  });

  it("renders no cards for an answer with no structure", () => {
    render(<EvidenceRail answer={PLAIN_ANSWER} toolPaths={[]} />);
    expect(screen.queryByRole("heading", { name: /Topology/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Asset hierarchy/ })).toBeNull();
    expect(screen.getByText(/Nothing to project yet/)).toBeInTheDocument();
  });

  it("renders nothing at all inline when there is nothing to show", () => {
    const { container } = render(
      <EvidenceRail answer={PLAIN_ANSWER} toolPaths={[]} inline />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("cited sources", () => {
  it("distinguishes a path the agent opened from one merely cited", () => {
    render(
      <EvidenceRail answer={FULL_ANSWER} toolPaths={["PID2Graph OPEN100/0.graphml"]} />,
    );
    expect(screen.getByText(/opened by agent/)).toBeInTheDocument();
    expect(screen.getAllByText(/cited in answer/).length).toBeGreaterThan(0);
  });

  it("shows the page number the answer stated", () => {
    render(<EvidenceRail answer={FULL_ANSWER} toolPaths={[]} />);
    expect(screen.getByText(/page 3/)).toBeInTheDocument();
  });

  it("never shows a truncated path", () => {
    render(<EvidenceRail answer={FULL_ANSWER} toolPaths={[]} />);
    expect(screen.queryByText("OPEN100/1.graphml")).toBeNull();
  });
});

describe("evidence support", () => {
  it("never displays a numeric confidence", () => {
    render(<EvidenceRail answer={FULL_ANSWER} toolPaths={[]} />);
    const card = screen
      .getByRole("heading", { name: /Evidence support/ })
      .closest("section");
    expect(card?.textContent ?? "").not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(card?.textContent ?? "").not.toMatch(/0\.\d\d/);
  });

  it("says a calibrated score is unavailable", () => {
    render(<EvidenceRail answer={FULL_ANSWER} toolPaths={[]} />);
    expect(screen.getByText(/Calibrated score unavailable/)).toBeInTheDocument();
  });

  it("reports a conflict when the answer states one", () => {
    render(<EvidenceRail answer={CONFLICTING_ANSWER} toolPaths={[]} />);
    expect(screen.getByText("Conflicting")).toBeInTheDocument();
  });
});

describe("topology and impacted assets", () => {
  it("renders the stated connectivity path in order", () => {
    render(<EvidenceRail answer={FULL_ANSWER} toolPaths={[]} />);
    const card = screen.getByRole("heading", { name: /Topology/ }).closest("section");
    const items = card?.querySelectorAll("li") ?? [];
    expect([...items].map((item) => item.textContent?.replace(/[\s↓]+/g, ""))).toEqual([
      "P-2101A",
      "FCV-2201",
      "E-2201",
    ]);
  });

  it("keeps a hyphenated tag intact", () => {
    // Scoped to the impacted card: the same tag legitimately appears in the topology card
    // as well, so a document-wide query would match both.
    render(<EvidenceRail answer={FULL_ANSWER} toolPaths={[]} />);
    const card = screen
      .getByRole("heading", { name: /impacted assets/i })
      .closest("section");
    const rows = [...(card?.querySelectorAll("li") ?? [])].map((row) =>
      row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows).toEqual(["E-2201 — downstream heat exchanger", "P-2101A — upstream pump"]);
  });
});
