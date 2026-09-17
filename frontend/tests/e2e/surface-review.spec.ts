import { expect, test } from "@playwright/test";

/** Read-only interaction audit; no paid model calls or changes to source records. */
test("review all workspace surfaces for rendering and local clipping", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const capture = async (name: string) => {
    await page.screenshot({
      path: `qa/review-${info.project.name}-${name}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  };
  await page.goto("/investigation");
  await expect(
    page.getByRole("heading", { name: "Evidence map", exact: true }),
  ).toBeVisible();
  for (const [name, label] of [
    ["evidence", /01 Evidence map/],
    ["asset", /02 Asset investigation/],
    ["brief", /03 Engineering brief/],
  ] as const) {
    await page.getByRole("button", { name: label }).click();
    await capture(name);
  }
  await page.goto("/canvas");
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 45000 });
  for (const name of ["Canvas", "Assets", "Files", "Simulation", "Twin"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("region", { name: `${name} workspace`, exact: true }),
    ).toBeVisible();
    await capture(name.toLowerCase());
  }
  for (const stage of ["pretraining", "sft", "rl", "distillation"]) {
    await page.goto(`/model-lab/${stage}`);
    // Each stage states what its page simulates, in its own words.
    await expect(page.getByRole("note")).toContainText(/Simulated/);
    await capture(stage);
  }
  await page.goto("/");
  await expect(page.getByLabel(/Ask an engineering question/i)).toBeVisible();
  await capture("assistant");
  expect(errors).toEqual([]);
});
