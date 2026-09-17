import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Accessibility, as a release gate rather than an afterthought.
 *
 * Automated checks catch contrast, naming and structure. They cannot catch whether the
 * thing is actually usable from the keyboard, so the keyboard flows below are explicit —
 * they drive the whole product with no pointer at all.
 */

function sessionUrl(label: string): string {
  return `/s/a11y-${label}-${Date.now().toString(36)}`;
}

async function ask(page: Page, question: string): Promise<void> {
  const composer = page.getByLabel(/Ask an engineering question/i);
  await composer.fill(question);
  await composer.press("Enter");
  await expect(page.getByText(/^Elapsed /).first()).toBeVisible({ timeout: 45_000 });
}

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  // Report every violation, not just the first, so one run tells the whole story.
  const summary = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n  ${violation.nodes
        .map((node) => node.target.join(" "))
        .join("\n  ")}`,
  );
  expect(summary, summary.join("\n\n")).toEqual([]);
}

test.describe("automated checks", () => {
  test("empty session has no violations", async ({ page }) => {
    await page.goto(sessionUrl("empty"));
    await expect(page.getByRole("heading", { name: "P&ID Intelligence" })).toBeVisible();
    await scan(page);
  });

  test("answered session has no violations", async ({ page }) => {
    await page.goto(sessionUrl("answered"));
    await ask(page, "What is FCV-2201?");
    await scan(page);
  });

  test("expanded activity panel has no violations", async ({ page }) => {
    await page.goto(sessionUrl("activity"));
    await ask(page, "What is FCV-2201?");
    await page.getByRole("button", { name: /Activity & tool calls/ }).click();
    await scan(page);
  });

  test("open dialog has no violations", async ({ page }) => {
    await page.goto(sessionUrl("dialog"));
    await ask(page, "A question.");
    await page.getByRole("button", { name: /Clear this session/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page);
  });
});

test.describe("keyboard", () => {
  test("the whole flow works without a pointer", async ({ page }) => {
    await page.goto(sessionUrl("keyboard"));

    // A skip link is the first stop, so a keyboard user reaches the composer immediately
    // rather than tabbing through the session list first.
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText(/Skip to question composer/);
    await page.keyboard.press("Enter");

    const composer = page.getByLabel(/Ask an engineering question/i);
    await composer.focus();
    await composer.type("What is FCV-2201?");
    await composer.press("Enter");

    await expect(page.getByText(/^Elapsed /).first()).toBeVisible({ timeout: 45_000 });
  });

  test("Shift+Enter inserts a newline instead of sending", async ({ page }) => {
    await page.goto(sessionUrl("shift-enter"));
    const composer = page.getByLabel(/Ask an engineering question/i);
    await composer.focus();
    await composer.type("first line");
    await composer.press("Shift+Enter");
    await composer.type("second line");

    await expect(composer).toHaveValue("first line\nsecond line");
    await expect(page.getByText(/^Elapsed /)).toHaveCount(0);
  });

  test("a dialog traps focus and restores it on close", async ({ page }) => {
    await page.goto(sessionUrl("focus-trap"));
    await ask(page, "A question.");

    const trigger = page.getByRole("button", { name: /Clear this session/ });
    await trigger.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Tab cycles inside the dialog rather than escaping to the page behind it.
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toHaveCount(1);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("focus stays where the user put it while a stream updates", async ({ page }) => {
    await page.goto(sessionUrl("focus-steal"));
    const composer = page.getByLabel(/Ask an engineering question/i);
    await composer.fill("What is FCV-2201?");
    await composer.press("Enter");

    // The composer is locked during a run, so focus moves to the Stop control at most —
    // never into the streaming answer, which would fight the user on every token.
    await expect(page.getByText(/^Elapsed /).first()).toBeVisible({ timeout: 45_000 });
    const focusedRole = await page.evaluate(() => document.activeElement?.tagName ?? "");
    expect(["BODY", "TEXTAREA", "BUTTON"]).toContain(focusedRole);
  });
});

test.describe("announcements", () => {
  test("announces completion once rather than every token", async ({ page }) => {
    await page.goto(sessionUrl("announce"));
    await ask(page, "What is FCV-2201?");

    const live = page.locator('[role="status"][aria-live="polite"]');
    await expect(live.first()).toBeAttached();
    await expect(page.getByText("Response completed.")).toBeAttached();

    // The answer itself must not be a live region: announcing every delta makes the page
    // unusable with a screen reader.
    const answer = page.getByRole("article", { name: "Assistant response" });
    await expect(answer).not.toHaveAttribute("aria-live", /.*/);
  });
});

test.describe("zoom and motion", () => {
  test("remains usable at 200% text zoom", async ({ page }) => {
    await page.goto(sessionUrl("zoom"));
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await ask(page, "What is FCV-2201?");

    await expect(page.getByLabel(/Ask an engineering question/i)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("honours a reduced-motion preference", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(sessionUrl("motion"));
    await ask(page, "What is FCV-2201?");

    // Nothing animates for longer than the reduced-motion override allows.
    const longest = await page.evaluate(() =>
      Math.max(
        0,
        ...[...document.querySelectorAll("*")].map((element) => {
          const style = getComputedStyle(element);
          return Math.max(
            Number.parseFloat(style.animationDuration) || 0,
            Number.parseFloat(style.transitionDuration) || 0,
          );
        }),
      ),
    );
    expect(longest).toBeLessThan(0.05);
  });
});
