import { expect, test } from "@playwright/test";

for (const stage of ["pretraining", "sft", "rl", "distillation"]) {
  test(`${stage}: execution advances, pauses and exposes data QC and evaluation`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/model-lab/${stage}`);
    const monitor = page.getByRole("region", {
      name: "Stage execution monitor",
      exact: true,
    });
    await expect(monitor).toBeVisible();
    const initial = await monitor.getAttribute("data-tick");
    await expect.poll(() => monitor.getAttribute("data-tick")).not.toBe(initial);
    await page.getByRole("button", { name: "Pause training stage", exact: true }).click();
    await expect(monitor).toHaveAttribute("data-running", "false");
    const paused = await monitor.getAttribute("data-tick");
    await page.waitForTimeout(1500);
    await expect(monitor).toHaveAttribute("data-tick", paused!);

    await monitor
      .getByRole("list", { name: "Execution phases" })
      .getByRole("button")
      .nth(3)
      .click();
    await expect(monitor).toContainText("PHASE INSPECTION");
    await monitor.getByRole("button", { name: "Follow execution", exact: true }).click();
    await expect(monitor).toContainText("FOLLOWING EXECUTION");
    await monitor.getByLabel("Diagnostic scenario").selectOption("input-stall");
    await expect(monitor).toContainText("Input starvation · update dispatch waiting");
    await monitor.getByLabel("Diagnostic scenario").selectOption("nominal");
    await monitor.screenshot({
      path: `qa/execution-${stage}-${testInfo.project.name}.png`,
    });

    await monitor.getByRole("button", { name: "Synthetic data QC", exact: true }).click();
    await expect(monitor).toContainText("0 admitted");
    await expect(
      monitor.getByRole("button", { name: /sdg-\d+-0-1 Exact duplicate/ }),
    ).toBeVisible();
    await monitor.getByRole("button", { name: /sdg-\d+-1-1 Invalid reference/ }).click();
    await expect(monitor).toContainText("Batch pinned for inspection");
    await expect(monitor).toContainText("Rejected: target node does not exist");
    await monitor.getByRole("button", { name: "Generate next batch", exact: true }).click();
    await expect(monitor.getByRole("button", { name: /sdg-\d+-0-0/ })).toBeVisible();
    await monitor.getByRole("button", { name: "Follow batches", exact: true }).click();
    await expect(monitor).toContainText("Following replay batches");
    await monitor.getByRole("button", { name: "Evaluation gates", exact: true }).click();
    await expect(monitor).toContainText("Production release: unvalidated");
    await monitor
      .getByText("Method references · verified 18 Sep 2026", { exact: true })
      .click();
    await expect(monitor.getByRole("link").first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
}

test("synthetic batches follow the run until a record is pinned", async ({ page }) => {
  await page.clock.install();
  await page.goto("/model-lab/pretraining");
  const monitor = page.getByRole("region", { name: "Stage execution monitor", exact: true });
  await monitor.getByRole("button", { name: "Synthetic data QC", exact: true }).click();
  const batch = monitor.locator("[data-batch]");
  const initial = await batch.getAttribute("data-batch");
  await page.clock.fastForward(20000);
  await expect.poll(() => batch.getAttribute("data-batch")).not.toBe(initial);
  await monitor.getByRole("group", { name: "Synthetic candidates", exact: true }).getByRole("button").first().click();
  const pinned = await batch.getAttribute("data-batch");
  await page.clock.fastForward(20000);
  await expect(batch).toHaveAttribute("data-batch", pinned!);
  await monitor.getByRole("button", { name: "Follow batches", exact: true }).click();
  await expect.poll(() => batch.getAttribute("data-batch")).not.toBe(pinned);
});
