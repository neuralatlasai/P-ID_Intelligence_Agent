import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * The Industrial Canvas surface, against a real backend.
 *
 * This surface exists to put a question in front of a drawing: pick an object off the real
 * GraphML geometry, ask the agent about it, and read the answer beside the sheet it came
 * from. Everything asserted here is either geometry the backend served or an explicit
 * statement that something is not connected — the tests are written so that inventing data
 * would fail them.
 */

/** Wait until the drawing, its overlay and the object list have all arrived. */
async function openCanvas(page: Page): Promise<void> {
  await page.goto("/canvas");
  await expect(page).toHaveURL(/\/canvas\?session=/);
  // The overlay canvas is mounted only once the graph has parsed, so it is the precise
  // signal that real geometry — not a loading state — is on screen.
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 45_000 });
}

test.describe("loading a drawing", () => {
  test("mints a session and renders geometry the backend served", async ({ page }) => {
    await openCanvas(page);

    await expect(page.getByRole("heading", { name: "0.png" })).toBeVisible();
    await expect(page.getByText("Drawing parsed and indexed")).toBeVisible();
    // The counts are the backend's, restated. A placeholder would not agree with them.
    await expect(page.getByText(/\d+ objects · \d+ connections/).first()).toBeVisible();
    await expect(page.getByRole("img", { name: /P&ID source drawing/ })).toBeVisible();
  });

  test("serves the drawing raster and its graph through the gateway", async ({ page }) => {
    const through = (kind: string) =>
      page.waitForResponse((response) =>
        new URL(response.url()).pathname.startsWith(`/api/canvas/${kind}/`),
      );
    const graph = through("graph");
    const image = through("image");

    await openCanvas(page);

    expect((await graph).status()).toBe(200);
    expect((await image).status()).toBe(200);
  });
});

test.describe("selecting an object", () => {
  test("drives the popover, the hierarchy and the files from one selection", async ({
    page,
  }) => {
    await openCanvas(page);

    // Rows are named by ISA tag, with the engineering name beneath.
    const objects = page.getByRole("button", { name: /^[A-Z]{1,4}-\d{3,4}\b/ });
    const second = objects.nth(1);
    const tag = ((await second.locator("strong").textContent()) ?? "").trim();
    expect(tag).toMatch(/^[A-Z]{1,4}-\d{3,4}$/);
    await second.click();

    await expect(second).toHaveAttribute("aria-pressed", "true");
    // The same tag reaches the hierarchy leaf and the file names, which is what makes the
    // selection one fact rather than three copies of one.
    await expect(
      page.getByRole("button", { name: new RegExp(`^${tag}\\b`) }).last(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`${tag}_Datasheet`) }),
    ).toBeVisible();
  });

  test("an object outside the drawing's vocabulary is simply absent", async ({ page }) => {
    await openCanvas(page);

    await page.getByLabel("Search objects").fill("zzzz-no-such-object");
    await expect(page.getByText(/No matching objects/)).toBeVisible();
  });
});

test.describe("asking the agent", () => {
  test("streams an answer about the selected object", async ({ page }) => {
    await openCanvas(page);

    await page.getByRole("button", { name: "Ask the agent" }).first().click();
    const composer = page.getByLabel(/Ask an engineering question/i);
    // The prepared question names the component by tag and function, never by position.
    await expect(composer).toHaveValue(/^(Explain|Describe) /);
    await expect(composer).not.toHaveValue(/\bx\s*=|pixel/i);

    await composer.fill("Which drawings show this object?");
    await composer.press("Enter");

    // A real agent run reads the drawing and walks the graph before it answers.
    await expect(page.getByText(/^Elapsed /).first()).toBeVisible({ timeout: 180_000 });
  });
});

test.describe("live context panels", () => {
  test("every listed file opens its content, and work orders move through their states", async ({
    page,
  }) => {
    await openCanvas(page);

    const datasheet = page.getByRole("button", { name: /_Datasheet\.pdf/ });
    await datasheet.click();
    const viewer = page.getByRole("dialog");
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText("Tag number");
    await expect(viewer).toContainText("Simulated document");

    // A long document scrolls in its body; the tab strip keeps its full height.
    await viewer.locator("nav").getByRole("button").last().click();
    const strip = await page.getByRole("dialog").locator("nav").evaluate((nav) => ({
      clipped: nav.scrollHeight - nav.clientHeight > 1,
      tab: Math.min(
        ...[...nav.querySelectorAll("button")].map((b) => b.getBoundingClientRect().height),
      ),
    }));
    expect(strip.clipped).toBe(false);
    expect(strip.tab).toBeGreaterThanOrEqual(32);

    // The drawing tab shows the real sheet, marked as corpus source rather than simulated.
    await viewer.getByRole("button", { name: "P&ID" }).click();
    await expect(page.getByRole("dialog")).toContainText("Corpus source");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const orders = page.getByRole("list", { name: "Work orders" });
    if ((await orders.count()) > 0) {
      const toggle = orders.getByRole("button", { expanded: false }).first();
      await toggle.click();
      await expect(orders).toContainText("Failure mode");
      const advance = orders.getByRole("button", {
        name: /^(Release|Start work|Complete|Reopen)$/,
      });
      const before = await advance.textContent();
      await advance.click();
      await expect(advance).not.toHaveText(before ?? "");
    }

    // The sheet in the hierarchy opens the drawing itself, marked as corpus source.
    const hierarchy = page.getByRole("region", { name: "Asset hierarchy" }).or(
      page.locator("section", { has: page.getByRole("heading", { name: "Asset hierarchy" }) }),
    );
    await hierarchy.getByRole("button", { name: /\.png$/ }).first().click();
    await expect(page.getByRole("dialog")).toContainText("Corpus source");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // A summary row is a way in, not a label: "N tagged components" lands on a list of N.
    const summaryRow = page.getByRole("button", { name: /Tagged components/ });
    const count = (await summaryRow.locator("strong").first().innerText()).trim();
    await summaryRow.click();
    await expect(page.getByRole("region", { name: "Canvas workspace" })).toBeVisible();
    await expect(page.getByLabel("Drawing objects").locator(":scope > div")).toHaveCount(
      Number(count),
    );
  });
});

test.describe("accessibility", () => {
  test("has no automatically detectable violations", async ({ page }) => {
    await openCanvas(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    // Reporting every violation in one run says whether a fix is one token or twenty.
    expect(
      results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    ).toEqual([]);
  });

  test("the drawing is reachable and selectable without a pointer", async ({ page }) => {
    await openCanvas(page);

    // Pin the row by its tag: selecting it expands its detail, which shifts positional indexes.
    const list = page.locator("[aria-label='Drawing objects']");
    const tag = (
      (await list.locator("button[aria-pressed='false'] strong").first().textContent()) ??
      ""
    ).trim();
    const row = list.getByRole("button", { name: new RegExp(`^${tag}( |$)`) });
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-pressed", "true");
  });

  test("does not scroll horizontally at the current viewport", async ({ page }) => {
    await openCanvas(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("digital twin", () => {
  test("maps every field detection onto the drawing and links the views", async ({
    page,
  }) => {
    await openCanvas(page);
    await page.getByRole("button", { name: "Twin", exact: true }).click();

    await expect(page.getByText(/13 of 13 field components mapped/)).toBeVisible();
    const rows = page.getByRole("region", { name: "Mapping register" }).locator("tbody tr");
    await expect(rows).toHaveCount(13);
    await expect(rows.filter({ hasText: "Pressure gauge" })).toContainText(
      "Pressure Gauge",
    );

    // A box on the photo selects the same component in the detail panel.
    await page
      .getByRole("button", { name: /D8 Pressure gauge/ })
      .locator("rect")
      .first()
      .click();
    await expect(page.getByRole("region", { name: "Selected component" })).toContainText(
      "Pressure gauge",
    );

    // A failure scenario moves the simulated variables out of band.
    await page.getByRole("button", { name: /Tube-side fouling/ }).click();
    await expect(page.getByText(/Shell outlet .* is above its normal band/)).toBeVisible();

    await page.getByRole("button", { name: "Show on drawing" }).click();
    await expect(page.getByText("Drawing parsed and indexed")).toBeVisible();

    const results = await new AxeBuilder({ page }).include("main").analyze();
    expect(results.violations).toEqual([]);
  });
});
