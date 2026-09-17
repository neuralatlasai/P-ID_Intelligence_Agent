import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openInvestigation(page: Page): Promise<void> {
  await page.goto("/investigation");
  await expect(page).toHaveURL(/\/investigation\?session=/);
  await expect(
    page.getByRole("heading", { name: "Evidence map", exact: true }),
  ).toBeVisible({
    timeout: 45_000,
  });
}

test("keeps one source node linked across all three investigation pages", async ({
  page,
}) => {
  await openInvestigation(page);

  await expect(page.getByText("12/12 node + class verified")).toBeVisible();
  await expect(page.getByText("ANN-001").first()).toBeVisible();
  await expect(page.getByText("ANN-012").first()).toBeVisible();
  await expect(page.getByText("OBS / controlled corpus drawing")).toBeVisible();
  await expect(page.getByText("Illustrative reference")).toBeVisible();
  const fusionImages = page.locator("[data-annotation-id] svg image");
  await expect(fusionImages).toHaveCount(12);
  const hrefs = await fusionImages.evaluateAll((images) =>
    images.map((element) => element.getAttribute("href")!),
  );
  for (const href of hrefs) expect((await page.request.get(href)).ok()).toBe(true);

  await page.getByRole("button", { name: /02 Asset investigation/ }).click();
  await expect(
    page.getByRole("heading", { name: "Selected component match" }),
  ).toBeVisible();
  await expect(page.getByText(/not plant evidence/)).toBeVisible();
  await page.getByRole("button", { name: /ANN-012 instrumentation61/ }).click();
  await expect(page.getByText("instrumentation61", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Weatherproof pressure switch")).toBeVisible();
  await expect(page.getByRole("region", { name: "Annotated field image" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Annotated P and ID crop" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Correlation proof" })).toContainText(
    "Annotation ↔ source node",
  );
  await expect(page.getByRole("region", { name: "Correlation proof" })).toContainText(
    "instrumentation = instrumentation / exact",
  );

  await page.getByRole("button", { name: /03 Engineering brief/ }).click();
  await expect(page.getByText("REGISTRY AND GRAPH CHECKED")).toBeVisible();
  await expect(page.getByLabel("Ask about this investigation")).toBeVisible();
});

test("sends linked context and renders the assistant stream contract", async ({ page }) => {
  // Contract fixture avoids a billed inference; backend transport is tested separately.
  await page.route("**/responses/stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: event\ndata: {"type":"response.output_text.delta","delta":"RCS-SG-100 is the drawing tag. The reference subtype remains unverified.","item_id":"test-answer"}\n\nevent: event\ndata: {"type":"response.completed"}\n\nevent: done\ndata: {}\n\n',
    });
  });
  await openInvestigation(page);

  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const composer = page.getByLabel("Ask about this investigation");
  await expect(composer).toBeFocused();
  await composer.fill("Explain this component and all linked evidence in plain language.");
  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().includes("/responses/stream"),
  );
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const request = await requestPromise;
  expect(request.postData()).toContain("ANN-001 -> tank67");
  expect(request.postData()).toContain("ANN-012 -> instrumentation61");

  expect(request.postData()).toContain("UNVERIFIED");
  await expect(page.getByText(/RCS-SG-100 is the drawing tag/)).toBeVisible({
    timeout: 45_000,
  });
});

test("maps every reference annotation to the exact GraphML coordinate", async ({
  page,
}) => {
  await openInvestigation(page);

  const annotationNodes = [
    ["ANN-001", "tank67"],
    ["ANN-002", "tank70"],
    ["ANN-003", "valve43"],
    ["ANN-004", "valve38"],
    ["ANN-005", "instrumentation14"],
    ["ANN-006", "instrumentation15"],
    ["ANN-007", "instrumentation22"],
    ["ANN-008", "instrumentation25"],
    ["ANN-009", "instrumentation31"],
    ["ANN-010", "instrumentation42"],
    ["ANN-011", "instrumentation60"],
    ["ANN-012", "instrumentation61"],
  ] as const;
  const graphResponse = await page.request.get(
    "/api/canvas/graph/PID2Graph%20OPEN100%2F0.graphml",
  );
  expect(graphResponse.ok()).toBe(true);
  const graph = (await graphResponse.json()) as {
    readonly nodes: readonly {
      readonly id: string;
      readonly x: number;
      readonly y: number;
    }[];
  };
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const fusionResponse = await page.request.get(
    "/api/canvas/fusion/PID2Graph%20OPEN100%2F0.graphml",
  );
  expect(fusionResponse.ok()).toBe(true);
  const fusion = (await fusionResponse.json()) as {
    readonly validation: {
      readonly status: string;
      readonly uniqueAnnotations: number;
      readonly uniqueNodes: number;
    };
    readonly records: readonly {
      readonly annotationId: string;
      readonly node: { readonly id: string; readonly kind: string };
      readonly expectedKind: string;
      readonly mappingStatus: string;
    }[];
  };
  expect(fusion.validation).toMatchObject({
    status: "verified",
    uniqueAnnotations: 12,
    uniqueNodes: 12,
  });
  expect(
    fusion.records.every(
      (record) =>
        record.expectedKind === record.node.kind &&
        record.mappingStatus === "verified-node-and-class",
    ),
  ).toBe(true);

  await expect(page.locator("[data-annotation-id]")).toHaveCount(12);
  await page.getByRole("button", { name: /02 Asset investigation/ }).click();

  for (const [annotationId, nodeId] of annotationNodes) {
    await page
      .getByRole("button", { name: new RegExp(`${annotationId} ${nodeId}`) })
      .click();
    const source = graphNodes.get(nodeId);
    expect(source).toBeDefined();
    const marker = page.getByTestId("source-node-marker");
    await expect(marker).toHaveAttribute(
      "aria-label",
      `P&ID crop with exact GraphML bounds for ${nodeId}`,
    );
    await expect(marker).toHaveAttribute("data-source-x", String(source?.x));
    await expect(marker).toHaveAttribute("data-source-y", String(source?.y));
    // Compare rendered screen transforms, not just attributes: catches cover-crop drift.
    const aligned = await page.locator("[data-annotation-id] svg").evaluate((svg) => {
      const image = svg.querySelector("image") as SVGImageElement;
      const box = svg.querySelector(
        '[data-testid="field-annotation-box"]',
      ) as SVGRectElement;
      const matrix = image.getScreenCTM();
      const rectMatrix = box.getScreenCTM();
      return (
        matrix &&
        rectMatrix &&
        ["a", "b", "c", "d", "e", "f"].every(
          (key) =>
            Math.abs(
              (matrix[key as keyof DOMMatrix] as number) -
                (rectMatrix[key as keyof DOMMatrix] as number),
            ) < 0.01,
        )
      );
    });
    expect(aligned).toBe(true);
  }
});

test("runs, pauses and replays the selected asset simulation", async ({ page }) => {
  await openInvestigation(page);
  await page.getByRole("button", { name: /02 Asset investigation/ }).click();
  await page.getByRole("button", { name: "Pause simulation", exact: true }).click();
  const reading = page.getByTestId("simulation-reading");
  const paused = await reading.innerText();
  await page.waitForTimeout(1200);
  await expect(reading).toHaveText(paused);
  await page.getByRole("button", { name: "Run simulation", exact: true }).click();
  await expect(reading).not.toHaveText(paused, { timeout: 4000 });
  await page.getByRole("button", { name: "Replay from start", exact: true }).click();
  await expect(page.locator("output").filter({ hasText: /t=0s/ })).toBeVisible();
  await page.getByRole("button", { name: /ANN-012 instrumentation61/ }).click();
  await expect(reading).toContainText("°C");
  await expect(page).toHaveURL(/node=instrumentation61/);
});

test("has no automatic accessibility violations or horizontal overflow", async ({
  page,
}) => {
  await openInvestigation(page);

  for (const buttonName of [
    /01 Evidence map/,
    /02 Asset investigation/,
    /03 Engineering brief/,
  ]) {
    await page.getByRole("button", { name: buttonName }).click();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    // Local clipping can occur without whole-page overflow, as in the reported card.
    const clipped = await page
      .locator('[class*="topologyRow"], [class*="topologyHeader"]')
      .evaluateAll((rows) =>
        rows
          .filter((row) => row.scrollWidth > row.clientWidth + 1)
          .map((row) => row.textContent),
      );
    expect(clipped).toEqual([]);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
