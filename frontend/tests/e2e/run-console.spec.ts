import { expect, test } from "@playwright/test";

/**
 * The run console is the live view of a stage: these pin that it moves, that replay speed
 * and pause do what they say, that an incident can be inspected, and that the log carries
 * history for each filter. Read-only against the session: every change is reverted.
 */
for (const stage of ["pretraining", "sft", "rl", "distillation"]) {
  test(`${stage}: console advances, replays, pauses and inspects incidents`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/model-lab/${stage}`);
    const console_ = page.getByRole("region", { name: "Run console", exact: true });
    await expect(console_).toBeVisible();
    await expect(console_).toHaveAttribute("data-status", "training");

    // Replay at 600×: training time visibly passes within a few seconds.
    await console_.getByRole("button", { name: "600×", exact: true }).click();
    await expect(
      console_.getByRole("button", { name: "600×", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const before = Number(await console_.getAttribute("data-step"));
    await expect
      .poll(async () => Number(await console_.getAttribute("data-step")), {
        timeout: 20_000,
      })
      .toBeGreaterThan(before);

    // Pause freezes it.
    await page.getByRole("button", { name: "Pause training stage", exact: true }).click();
    await expect(console_).toHaveAttribute("data-status", "paused");
    const paused = await console_.getAttribute("data-step");
    await page.waitForTimeout(1500);
    await expect(console_).toHaveAttribute("data-step", paused!);

    // Inspecting an incident re-windows the charts around it.
    const incidents = console_
      .getByRole("list", { name: "Recent incidents" })
      .getByRole("button");
    if ((await incidents.count()) > 0) {
      await incidents.first().click();
      await expect(console_.getByText(/^Inspecting /)).toBeVisible();
      await console_.getByRole("button", { name: "Back to live", exact: true }).click();
      await expect(console_.getByText(/^Inspecting /)).toHaveCount(0);
    }

    // Each log filter reaches back for its own history.
    const log = console_.getByRole("region", { name: /^Run log/ });
    await console_.getByRole("button", { name: "Warnings", exact: true }).click();
    await expect(
      log.locator("li[data-level='WARNING'], li[data-level='ERROR']").first(),
    ).toBeVisible();
    await console_.getByRole("button", { name: "Checkpoints", exact: true }).click();
    await expect(log.locator("li[data-source='checkpoint']").first()).toBeVisible();
    await console_.getByRole("button", { name: "All", exact: true }).click();
    await expect(log.locator("li[data-source='trainer']").first()).toBeVisible();

    // Restore the session for the next test: real time, running.
    await console_.getByRole("button", { name: "Real time", exact: true }).click();
    await page.getByRole("button", { name: /^(Resume|Run) training stage$/ }).click();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
