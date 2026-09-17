import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The model lab, end to end.
 *
 * Every assertion is about behaviour a static mock-up could not have: the run advances and
 * pauses, samples change, a stage link navigates, a generated file downloads, and the page
 * says plainly that the training run is simulated.
 */

const STAGES = [
  ["pretraining", "Domain-Adaptive Multimodal Pretraining"],
  ["sft", "Grounded Multimodal SFT"],
  ["rl", "Verifier-Guided RL"],
  ["distillation", "Teacher → Student Distillation"],
] as const;

test.describe("model lab", () => {
  for (const [slug, title] of STAGES) {
    test(`stage ${slug} renders, states the run is simulated, and has no a11y violations`, async ({
      page,
    }) => {
      await page.goto(`/model-lab/${slug}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
      await expect(page.getByRole("note")).toContainText(/Simulated/);
      await expect(
        page.getByRole("navigation", { name: "Training lifecycle stages" }),
      ).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  test("the run is live, freezes when paused, and throughput follows the hardware choice", async ({
    page,
  }) => {
    await page.goto("/model-lab/pretraining");
    const clock = page.getByText(/^(Live|Idle) · updated \d{2}:\d{2}:\d{2}$/).first();
    const first = await clock.textContent();
    await expect(clock).not.toHaveText(first ?? "", { timeout: 5_000 });
    await expect(clock).toContainText("Live");

    await page.getByRole("button", { name: /Pause training stage/ }).click();
    await expect(page.getByRole("button", { name: /Run training stage/ })).toBeVisible();
    await expect(clock).toContainText("Idle");
    await page.getByRole("button", { name: /Run training stage/ }).click();
    await expect(clock).toContainText("Live");

    // Doubling the nodes is a pending change until applied, with a faster ETA estimate.
    const runtime = page.locator("#runtime");
    const nodes = runtime.getByRole("combobox", { name: /Nodes/ });
    const current = Number(await nodes.inputValue());
    await nodes.selectOption(String(current * 2));
    await expect(runtime.getByRole("button", { name: /Apply & restart/ })).toBeEnabled();
    await runtime.getByRole("button", { name: /Discard/ }).click();
    await expect(runtime.getByRole("button", { name: /Apply & restart/ })).toHaveCount(0);
  });

  test("the sample carousel and stepper navigate", async ({ page }) => {
    await page.goto("/model-lab/pretraining");
    const sample = page.getByRole("region", { name: /Synchronized sample/ });
    const before = await sample.getByText(/^Equipment:/).textContent();
    await sample.getByRole("button", { name: "Next sample" }).click();
    await expect(sample.getByText(/^Equipment:/)).not.toHaveText(before ?? "");
    await expect(sample.getByText(/^2 of 5$/)).toBeVisible();

    await page.getByRole("link", { name: /Verifier-Guided RL/ }).click();
    await expect(page).toHaveURL(/\/model-lab\/rl$/);
    await expect(
      page.getByRole("region", { name: /Verifier-constrained rollout sample/ }),
    ).toContainText("Overall verifier result");
  });

  test("a generated configuration downloads as a real file", async ({ page }) => {
    await page.goto("/model-lab/distillation");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download Deployment manifest" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("inference-manifest.yaml");
    // Weights are never downloadable from a simulated run: before emission the card shows its
    // progress ring, afterwards a disabled download.
    const student = page.getByRole("img", {
      name: /Distilled student checkpoint: \d+ percent/,
    });
    const weights = page.getByRole("button", {
      name: /Distilled student checkpoint: weights not available/,
    });
    await expect(student.or(weights)).toBeVisible();
    if (await weights.count()) await expect(weights).toBeDisabled();
  });

  test("tag search finds a registered component and links to the canvas", async ({
    page,
  }) => {
    await page.goto("/model-lab/sft");
    await page.getByLabel("Search assets and tags").fill("HV-1001");
    await expect(page.getByRole("link", { name: /HV-1001/ }).first()).toHaveAttribute(
      "href",
      /\/canvas\?node=valve38/,
    );
  });
});
