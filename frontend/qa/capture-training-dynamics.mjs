import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  for (const stage of ["pretraining", "sft", "rl", "distillation"]) {
    await page.goto(`http://localhost:3300/model-lab/${stage}`);
    const navigation = page.getByRole("navigation", { name: "Stage analysis sections" });
    await navigation.getByRole("link", { name: /Model computation/ }).click();
    await page.screenshot({ path: `qa/training-dynamics-${stage}.png` });
  }
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto("http://localhost:3300/model-lab/pretraining");
  await page.getByRole("navigation", { name: "Stage analysis sections" }).getByRole("link", { name: /Model computation/ }).click();
  await page.screenshot({ path: "qa/training-dynamics-mobile-path.png" });
  await page.getByRole("heading", { name: "What drives the update", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "qa/training-dynamics-mobile-signals.png" });
  process.stdout.write(JSON.stringify(await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))));
} finally {
  await browser.close();
}
