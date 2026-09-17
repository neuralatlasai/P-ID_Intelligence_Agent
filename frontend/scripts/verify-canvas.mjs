/** Source reads use the real gateway/backend. Agent transport is mocked to avoid provider calls. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1672, height: 942 } });
const page = await context.newPage();
const errors = [];
let persisted = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/sessions/*/items", (route) => route.fulfill({ json: persisted }));
await page.route("**/api/sessions/*/responses/stream", async (route) => {
  const input = route.request().postDataJSON();
  expect(input[0].content).toContain("PID2Graph OPEN100/0.graphml");
  const answer = "Observed\nThe selected source object has undirected connections.";
  persisted = [
    input[0],
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: answer }],
    },
  ];
  const events = [
    { type: "response.created" },
    { type: "response.output_text.delta", delta: answer },
    { type: "response.completed" },
  ];
  await route.fulfill({
    contentType: "text/event-stream",
    body:
      events.map((event) => `event: event\ndata: ${JSON.stringify(event)}\n\n`).join("") +
      "event: done\ndata: {}\n\n",
  });
});
await page.route("**/api/health", (route) => route.fulfill({ json: { status: "ready" } }));
await mkdir("test-results/canvas", { recursive: true });
try {
  await page.goto("http://localhost:3010/canvas");
  await expect(
    page.getByRole("heading", { name: "Main steam system", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /P&ID source drawing:/ })).toBeVisible();
  await expect(page.getByText("Source data connected", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/canvas/desktop.png", fullPage: true });
  await page.getByRole("textbox", { name: "Search objects" }).fill("tank");
  await expect(page.getByRole("button", { name: /^tank/ })).toHaveCount(2);
  await page.getByRole("button", { name: /^tank/ }).first().click();
  await page.getByRole("button", { name: "Assets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connected objects" })).toBeVisible();
  await page.getByRole("button", { name: "Highlight on drawing" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Connections", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByLabel("Zoom level")).toHaveText("125%");
  await page.getByRole("button", { name: "Fit drawing" }).click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await expect(
    page.getByText("Traversal depth", { exact: true }).locator("..").getByRole("strong"),
  ).not.toHaveText("0");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const frozen = await page
    .getByText("Traversal depth", { exact: true })
    .locator("..")
    .innerText();
  await page.waitForTimeout(1100);
  expect(
    await page.getByText("Traversal depth", { exact: true }).locator("..").innerText(),
  ).toBe(frozen);
  await page.getByRole("slider", { name: "Signal baseline" }).fill("80");
  await expect(
    page.getByRole("img", { name: /Simulated signal trend.*baseline 80/ }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Reset simulation" }).click();
  await expect(
    page.getByText("Traversal depth", { exact: true }).locator("..").getByRole("strong"),
  ).toHaveText("0");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Source library" })).toBeVisible();
  await page.getByRole("button", { name: "Analyze selected object" }).click();
  await expect(page.getByRole("textbox", { name: /question/i })).toHaveValue(
    /Inspect node tank/,
  );
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(
    page.getByText("The selected source object has undirected connections.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Canvas", exact: true }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("textbox", { name: "Search objects" }).fill("");
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/canvas/mobile.png", fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await expect(page.getByRole("button", { name: "Run simulation" })).toBeVisible();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  const alternative = "PID2Graph OPEN100/1.graphml";
  for (
    let count = 0;
    count < 4 &&
    (await page.getByRole("option", { name: alternative, exact: true }).count()) === 0;
    count += 1
  ) {
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/canvas/drawings?offset="),
      ),
      page.getByRole("button", { name: "Next", exact: true }).click(),
    ]);
  }
  await page.getByRole("combobox", { name: "Drawing source" }).selectOption(alternative);
  await expect(
    page.getByRole("img", { name: `P&ID source drawing: PID2Graph OPEN100/1.png` }),
  ).toBeVisible();
  await expect(page.getByText("Source data connected", { exact: true })).toBeVisible();
  await page.route("**/api/canvas/graph/**", (route) =>
    route.fulfill({ status: 503, json: { error: { message: "Unavailable" } } }),
  );
  await page.getByRole("button", { name: "Refresh source", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
  await expect(page.getByText(/Drawing service returned HTTP 503/)).toBeVisible();
  await page.getByRole("button", { name: "Open offline demonstration" }).click();
  await expect(page.getByText("Offline demonstration", { exact: true })).toBeVisible();
  await page.unroute("**/api/canvas/graph/**");
  await page.getByRole("button", { name: "Refresh source", exact: true }).click();
  await expect(page.getByText("Source data connected", { exact: true })).toBeVisible();
  const sessionUrl = page.url();
  await page.reload();
  await expect(page.getByText("Source data connected", { exact: true })).toBeVisible();
  expect(page.url()).toBe(sessionUrl);
  expect(errors).toEqual([]);
  // eslint-disable-next-line no-console -- standalone verification report
  console.log(
    "Canvas source transport, source switching, failure recovery, session URL, navigation, zoom, playback, agent context, accessibility and mobile overflow passed.",
  );
} finally {
  await browser.close();
}
