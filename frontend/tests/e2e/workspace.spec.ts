import { expect, test, type Page } from "@playwright/test";

/**
 * The reference workflow, against a real backend.
 *
 * These cover what only a real browser can: streaming that actually streams, a session that
 * survives a refresh, two sessions that stay isolated, and a layout that keeps every
 * function reachable as the viewport narrows.
 */

/** A fresh session address, so tests never collide in the shared backend database. */
function sessionUrl(label: string): string {
  return `/s/e2e-${label}-${Date.now().toString(36)}`;
}

async function ask(page: Page, question: string): Promise<void> {
  const composer = page.getByLabel(/Ask an engineering question/i);
  await composer.fill(question);
  await composer.press("Enter");
}

/** Locate a question inside the transcript, not in the sidebar's session label. */
function askedQuestion(page: Page, text: string) {
  return page.getByRole("article", { name: "Your question" }).filter({ hasText: text });
}

/**
 * Reveal the session list.
 *
 * Below the sidebar breakpoint it is a drawer, so its controls need one tap to reach. The
 * tests use this rather than assuming a desktop layout, which is also what proves the
 * drawer is genuinely reachable at every width.
 */
async function openSessions(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /Show sessions/i });
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  await expect(page.getByRole("button", { name: /New session/ })).toBeVisible();
}

/**
 * How long a turn may take.
 *
 * The scripted backend answers in under a second; a live model with tools routinely takes
 * a minute or more, and a drawing question that magnifies a region takes longer still. The
 * shorter bound used to fail every question test whenever the suite was pointed at a real
 * backend, which made a working product look broken.
 */
const ANSWER_TIMEOUT_MS = 180_000;

async function waitForAnswer(page: Page): Promise<void> {
  // "Elapsed" appears only once the run has finished and history has been reconciled, so
  // it is a precise signal that the turn is genuinely complete rather than merely visible.
  await expect(page.getByText(/^Elapsed /).first()).toBeVisible({
    timeout: ANSWER_TIMEOUT_MS,
  });
}

test.describe("first load", () => {
  test("the root mints a session and redirects to its address", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/s\/[A-Za-z0-9._-]+$/);
  });

  test("an empty session offers example questions that do not submit themselves", async ({
    page,
  }) => {
    await page.goto(sessionUrl("empty"));
    await expect(page.getByRole("heading", { name: "P&ID Intelligence" })).toBeVisible();

    const example = page.getByRole("button", { name: /List the equipment shown/ });
    await example.click();

    // The example populates the composer. Submitting stays the user's decision.
    await expect(page.getByLabel(/Ask an engineering question/i)).toHaveValue(
      /List the equipment shown/,
    );
    await expect(page.getByText(/^Elapsed /)).toHaveCount(0);
  });

  test("the header carries the session controls and no runtime commentary", async ({
    page,
  }) => {
    await page.goto(sessionUrl("header"));

    await expect(page.getByRole("button", { name: /Copy full session ID/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Industrial Canvas" })).toBeVisible();

    // The framework and the health probe are implementation detail. Health still reaches
    // the reader, but only where it changes what they can do: the composer refuses to send
    // while the backend is down.
    await expect(page.getByText(/Agents SDK/i)).toHaveCount(0);
    await expect(page.getByText(/Backend (ready|degraded|unavailable)/i)).toHaveCount(0);
    await expect(page.getByText(/Session active|persists across restarts/)).toHaveCount(0);
  });

  test("a malformed session address is not found", async ({ page }) => {
    const response = await page.goto("/s/..%2Fescape");
    expect(response?.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe("asking a question", () => {
  test("streams an answer and reconciles it with backend history", async ({ page }) => {
    await page.goto(sessionUrl("stream"));
    await ask(page, "What is FCV-2201?");

    // The question appears immediately; the answer arrives incrementally.
    await expect(askedQuestion(page, "What is FCV-2201?")).toBeVisible();
    await waitForAnswer(page);

    // Deliberately not asserting a particular section: whether an answer has an Observed
    // block depends on whether this deployment's corpus holds the tag, and the suite must
    // pass against any corpus. What must hold for every answer is that one arrived, in the
    // assistant's own turn, and that the run was reconciled with backend history.
    await expect(page.getByRole("article", { name: "Assistant response" })).toBeVisible();
  });

  test("shows observable tool activity without exposing reasoning", async ({ page }) => {
    await page.goto(sessionUrl("activity"));
    await ask(page, "What is FCV-2201?");
    await waitForAnswer(page);

    await page.getByRole("button", { name: /Activity & tool calls/ }).click();
    await expect(page.getByText("graph_summary")).toBeVisible();

    // Tool arguments and reasoning must never appear.
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toContain("chain of thought");
    expect(body).not.toContain('{"path"');
  });

  test("keeps a follow-up in the same session", async ({ page }) => {
    const url = sessionUrl("followup");
    await page.goto(url);

    await ask(page, "What is FCV-2201?");
    await waitForAnswer(page);

    await ask(page, "And what is downstream of it?");
    await expect(askedQuestion(page, "And what is downstream of it?")).toBeVisible();
    await expect(page.getByText(/^Elapsed /)).toHaveCount(1, {
      timeout: ANSWER_TIMEOUT_MS,
    });

    await expect(page).toHaveURL(new RegExp(url.replace(/[/]/g, "\\/")));
    await expect(page.getByRole("article", { name: "Your question" })).toHaveCount(2);
  });

  test("restores the transcript after a reload", async ({ page }) => {
    const url = sessionUrl("reload");
    await page.goto(url);
    await ask(page, "What is FCV-2201?");
    await waitForAnswer(page);

    await page.reload();

    // The backend is the authority: the answer comes back from its history, not from
    // anything the browser kept.
    await expect(askedQuestion(page, "What is FCV-2201?")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("article", { name: "Assistant response" })).toBeVisible();
  });

  test("keeps two sessions isolated", async ({ page }) => {
    const first = sessionUrl("iso-a");
    await page.goto(first);
    await ask(page, "First session question about FCV-2201.");
    await waitForAnswer(page);

    await page.goto(sessionUrl("iso-b"));
    // Scoped to the transcript. The sidebar legitimately lists visited sessions by their
    // first question, so a page-wide query would match that label and prove nothing.
    await expect(
      page.getByRole("article", { name: "Your question" }).filter({
        hasText: "First session question about FCV-2201.",
      }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "P&ID Intelligence" })).toBeVisible();

    await page.goto(first);
    await expect(
      askedQuestion(page, "First session question about FCV-2201."),
    ).toBeVisible();
  });
});

test.describe("evidence", () => {
  test("cites the corpus files the answer rests on", async ({ page }) => {
    await page.goto(sessionUrl("evidence"));
    await ask(page, "What is FCV-2201?");
    await waitForAnswer(page);

    const heading = page.getByRole("heading", { name: /Cited drawings/ });
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeVisible();
    await expect(page.getByText(/opened by agent/).first()).toBeVisible();
  });

  test("never shows a numeric confidence", async ({ page }) => {
    await page.goto(sessionUrl("confidence"));
    await ask(page, "What is FCV-2201?");
    await waitForAnswer(page);

    const supportHeading = page.getByRole("heading", { name: /Evidence support/ });
    await supportHeading.scrollIntoViewIfNeeded();
    const support = supportHeading.locator("xpath=ancestor::section[1]");
    await expect(support).toBeVisible();
    await expect(support).toContainText(/Calibrated score unavailable/);
    await expect(support).not.toContainText(/%/);
  });
});

test.describe("session management", () => {
  test("starts an independent new session", async ({ page }) => {
    await page.goto(sessionUrl("new"));
    await ask(page, "A question in the first session.");
    await waitForAnswer(page);

    const before = page.url();
    await openSessions(page);
    await page.getByRole("button", { name: /New session/ }).click();

    await expect(page).not.toHaveURL(before);
    await expect(
      page.getByRole("article", { name: "Your question" }).filter({
        hasText: "A question in the first session.",
      }),
    ).toHaveCount(0);
  });

  test("clears a session's history after confirmation", async ({ page }) => {
    await page.goto(sessionUrl("clear"));
    await ask(page, "A question that will be cleared.");
    await waitForAnswer(page);

    await page.getByRole("button", { name: /Clear this session/ }).click();
    const dialog = page.getByRole("dialog", { name: /Clear this session/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/cannot be undone/);

    await dialog.getByRole("button", { name: "Clear history" }).click();

    await expect(
      page.getByRole("article", { name: "Your question" }).filter({
        hasText: "A question that will be cleared.",
      }),
    ).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "P&ID Intelligence" })).toBeVisible();
  });

  test("lists visited sessions and says the list is local", async ({ page }) => {
    await page.goto(sessionUrl("list"));
    await ask(page, "A labelled question.");
    await waitForAnswer(page);

    await openSessions(page);
    const sidebar = page.getByRole("navigation", { name: /Recent sessions/ });
    await expect(sidebar.getByText("A labelled question.")).toBeVisible();
    // The list cannot be complete, and the UI says so rather than implying otherwise.
    await expect(page.getByText(/sessions opened elsewhere are not shown/i)).toBeAttached();
  });
});

test.describe("responsive layout", () => {
  test("keeps every function reachable at the current viewport", async ({ page }) => {
    await page.goto(sessionUrl("responsive"));
    await ask(page, "What is FCV-2201?");
    await waitForAnswer(page);

    // Evidence is rendered exactly once, wherever the layout puts it. Rendering it in
    // both the rail and the inline stack would duplicate every citation for a screen
    // reader, so the count matters as much as the presence.
    await expect(page.getByRole("heading", { name: /Cited drawings/ })).toHaveCount(1);
    await expect(page.getByLabel(/Ask an engineering question/i)).toBeVisible();

    // Whatever the width, the session list is reachable — inline or through the drawer.
    await openSessions(page);
  });

  test("does not scroll horizontally", async ({ page }) => {
    await page.goto(sessionUrl("overflow"));
    await ask(page, "What is FCV-2201?");
    await waitForAnswer(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
