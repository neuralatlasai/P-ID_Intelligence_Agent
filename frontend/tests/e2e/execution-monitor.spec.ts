import { expect, test } from "@playwright/test";

/**
 * The execution monitor is now figure 04B, synthetic data QC: a batch flow, the candidate
 * matrix and the selected record's QC gates. Phase, diagnostics and evaluation views were
 * removed — the run console, the step anatomy and §05 each draw those once.
 */
for (const stage of ["pretraining", "sft", "rl", "distillation"]) {
  test(`${stage}: synthetic QC follows the replay, pauses and pins a record`, async ({
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

    await expect(
      monitor.getByRole("img", { name: /Synthetic batch QC flow/ }),
    ).toBeVisible();
    await expect(monitor).toContainText("0 admitted");
    await expect(
      monitor.getByRole("button", { name: /sdg-\d+-0-1 Exact duplicate/ }),
    ).toBeVisible();
    await monitor.getByRole("button", { name: /sdg-\d+-1-1 Invalid reference/ }).click();
    await expect(monitor).toContainText("pinned");
    const gates = monitor.getByRole("list", { name: "QC gates" });
    await expect(gates.locator("li[data-state='fail']")).toHaveCount(1);
    await expect(gates.locator("li[data-state='open']").first()).toBeVisible();
    await monitor.screenshot({
      path: `qa/execution-${stage}-${testInfo.project.name}.png`,
    });
    await monitor.getByRole("button", { name: "Generate next batch", exact: true }).click();
    await expect(monitor.getByRole("button", { name: /sdg-\d+-0-0/ })).toBeVisible();
    await monitor.getByRole("button", { name: "Follow batches", exact: true }).click();
    await expect(monitor).toContainText("following");
    await monitor
      .getByText("Method references · verified 18 Sep 2026", { exact: true })
      .click();
    await expect(monitor.getByRole("link").first()).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    await page.getByRole("button", { name: /^(Resume|Run) training stage$/ }).click();
  });
}

test("synthetic batches follow the run until a record is pinned", async ({ page }) => {
  await page.clock.install();
  await page.goto("/model-lab/pretraining");
  const monitor = page.getByRole("region", {
    name: "Stage execution monitor",
    exact: true,
  });
  const batch = monitor.locator("[data-batch]");
  const initial = await batch.getAttribute("data-batch");
  await page.clock.fastForward(20000);
  await expect.poll(() => batch.getAttribute("data-batch")).not.toBe(initial);
  await monitor
    .getByRole("group", { name: "Synthetic candidates", exact: true })
    .getByRole("button")
    .first()
    .click();
  const pinned = await batch.getAttribute("data-batch");
  await page.clock.fastForward(20000);
  await expect(batch).toHaveAttribute("data-batch", pinned!);
  await monitor.getByRole("button", { name: "Follow batches", exact: true }).click();
  await expect.poll(() => batch.getAttribute("data-batch")).not.toBe(pinned);
});
