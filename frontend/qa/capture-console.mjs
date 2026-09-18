/**
 * Captures the Model Lab run console for every stage, for visual review.
 *
 *   node qa/capture-console.mjs [baseUrl]
 *
 * Writes qa/console-<stage>.png (the console) and qa/console-<stage>-incident.png (the same
 * console inspecting its most recent incident). Read-only: it pauses nothing and changes
 * no stored session.
 */
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:3010";
const stages = ["pretraining", "sft", "rl", "distillation"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

for (const stage of stages) {
  await page.goto(`${base}/model-lab/${stage}`, { waitUntil: "networkidle" });
  const console_ = page.getByRole("region", { name: "Run console", exact: true });
  await console_.waitFor({ timeout: 30000 });
  await console_.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await console_.screenshot({ path: `qa/console-${stage}.png` });
  const recent = console_.getByRole("list", { name: "Recent incidents" }).getByRole("button");
  if ((await recent.count()) > 0) {
    await recent.first().click();
    await page.waitForTimeout(600);
    await console_.screenshot({ path: `qa/console-${stage}-incident.png` });
  }
  console.log(`${stage}: captured`);
}

console.log(errors.length ? `page errors:\n${errors.join("\n")}` : "no page errors");
await browser.close();
