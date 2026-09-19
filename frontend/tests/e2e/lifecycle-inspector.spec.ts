import { expect, test } from "@playwright/test";

/** Verify the inspector follows real selection and applied, rather than draft, settings. */
test("lifecycle inspector keeps sample identity and applied architecture aligned", async ({
  page,
}) => {
  await page.goto("/model-lab/pretraining");
  const sections = page.getByRole("navigation", { name: "Stage analysis sections" });
  await expect(sections).toBeVisible();
  await sections.getByRole("link", { name: /Input conversion/ }).click();
  // The raw JSON is collapsed behind a disclosure beneath the conversion diagram.
  await page.getByText("Raw record", { exact: true }).click();
  const record = page.getByLabel("Selected source record", { exact: true });
  const before = JSON.parse((await record.textContent())!);
  await page.getByRole("button", { name: "Next sample", exact: true }).click();
  await expect
    .poll(async () => JSON.parse((await record.textContent())!).node_id)
    .not.toBe(before.node_id);
  const selected = JSON.parse((await record.textContent())!);
  await expect(page.getByRole("region", { name: /Synchronized sample/ })).toContainText(
    selected.asset_tag,
  );

  await page.getByRole("button", { name: "Batch specification", exact: true }).click();
  const batch = page.getByLabel("Model batch specification", { exact: true });
  const applied = JSON.parse((await batch.textContent())!).global_batch;
  const runtime = page.locator("#runtime");
  const batchControl = runtime.getByRole("combobox", { name: "Global batch", exact: true });
  const options = await batchControl
    .locator("option")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  const next = options.find((value) => Number(value) !== applied)!;
  await batchControl.selectOption(next);
  expect(JSON.parse((await batch.textContent())!).global_batch).toBe(applied);
  await runtime.getByRole("button", { name: /Apply & restart/ }).click();
  await expect
    .poll(async () => JSON.parse((await batch.textContent())!).global_batch)
    .toBe(Number(next));

  await sections.getByRole("link", { name: /Model computation/ }).click();
  const heading = await page
    .getByRole("heading", { name: "Model computation", exact: true })
    .boundingBox();
  expect(heading?.y).toBeGreaterThan(
    (page.viewportSize()?.width ?? 1600) <= 820 ? 100 : 46,
  );
  await expect(page.getByRole("img", { name: /^Tensor-shape ribbon/ })).toBeVisible();
  // A narrow screen may scroll the data table internally; the document must stay bounded.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
