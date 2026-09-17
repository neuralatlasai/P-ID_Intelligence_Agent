import { expect, test } from "@playwright/test";

test("the architecture figure follows the run and can be paused, replayed and frozen", async ({
  page,
}) => {
  await page.goto("/model-lab/pretraining");
  const figure = page.getByRole("figure", { name: /FIGURE 03/ });
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute("data-motion", "true");
  await expect(page.getByTestId("reference-packet")).toHaveCount(1);

  // Local pause holds the path without pausing training.
  await figure.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(figure).toHaveAttribute("data-motion", "false");
  await expect(figure.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await figure.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(figure).toHaveAttribute("data-motion", "true");

  // Pausing the training stage freezes the path and the signal charts with it.
  const workbench = page.getByRole("region", { name: "Training signal workbench", exact: true });
  const charts = await workbench
    .locator("polyline")
    .evaluateAll((lines) => lines.map((line) => line.getAttribute("points")));
  await page.getByRole("button", { name: "Pause training stage", exact: true }).click();
  await expect(figure).toHaveAttribute("data-motion", "false");
  await page.waitForTimeout(2500);
  expect(
    await workbench
      .locator("polyline")
      .evaluateAll((lines) => lines.map((line) => line.getAttribute("points"))),
  ).toEqual(charts);

  await workbench.getByRole("button", { name: /Contrastive alignment:.*percent/ }).click();
  await expect(
    workbench.getByRole("button", { name: /Contrastive alignment:.*percent/ }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("reduced motion keeps the figure static and readable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/model-lab/distillation");
  const figure = page.getByRole("figure", { name: /FIGURE 03/ });
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute("data-motion", "false");
  await expect(page.getByTestId("reference-packet")).toHaveCount(0);
  await expect(figure.getByRole("button", { name: "Replay", exact: true })).toBeDisabled();
  await expect(figure).toContainText("Reduced motion · static reference path");
  const workbench = page.getByRole("region", { name: "Training signal workbench", exact: true });
  await expect(workbench).toContainText("Loss weights are not configured");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
