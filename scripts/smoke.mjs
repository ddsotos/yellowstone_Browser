import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";

const browser = await chromium.launch({
  executablePath:
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.SMOKE_URL ?? "http://127.0.0.1:4173/", {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await page.getByText("強化NPC", { exact: true }).click();
  await page.getByText("AI分析モード", { exact: true }).click();
  await page.getByText("新しいゲーム", { exact: true }).click();
  if (!(await page.getByRole("button", { name: "OFF" }).isVisible())) {
    throw new Error("frame selection must default to OFF");
  }
  await page.getByRole("button", { name: "OFF" }).click();
  await page.locator(".hand-card").first().click();
  await page.locator(".board-cell.is-legal").first().click();
  await mkdir("test-artifacts", { recursive: true });
  await page.locator(".frame-confirm").waitFor();
  await page.screenshot({
    path: "test-artifacts/frame-selection.png",
    fullPage: true,
  });
  await page.locator(".frame-confirm").click();
  await page.getByText("1枚プレイで終える", { exact: true }).waitFor();
  await page.screenshot({
    path: "test-artifacts/one-card-choice.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "ON" }).click();
  await page.locator(".hand-card").first().click();
  await page.locator(".board-cell.is-legal").first().click();
  if (await page.locator(".frame-confirm").count()) {
    throw new Error("default frame selection should auto-confirm the best frame");
  }
  if ((await page.locator(".planned-refill button").count()) < 2) {
    throw new Error("two-card no-refill choice must be displayed");
  }
  if (!(await page.getByText("補充しない", { exact: true }).count())) {
    throw new Error("two-card no-refill choice must be displayed");
  }
  await page.getByText("山札から補充", { exact: true }).click();

  const comparison = page.locator(".comparison");
  const unavailable = page.getByText(
    /AI分析を利用できません|AI分析が10秒を超えました/,
  );
  await Promise.race([
    comparison.waitFor({ state: "visible", timeout: 45_000 }),
    unavailable.waitFor({ state: "visible", timeout: 45_000 }),
  ]);
  if (await comparison.isVisible()) {
    if (!(await comparison.getByText(/山札から補充/).first().isVisible())) {
      throw new Error("refill choice was not included in move description");
    }
    const modelCards = comparison.locator(".model-comparison");
    const modelCardCount = await modelCards.count();
    if (modelCardCount !== 5) {
      throw new Error(
        `five model result sections were not displayed: ${modelCardCount}; ${await comparison.innerText()}`,
      );
    }
    const rates = await comparison.locator(".comparison-cards strong").allTextContents();
    if (
      rates.length !== 20 ||
      rates.filter((rate) => rate.endsWith("%")).length !== 16 ||
      rates.filter((rate) => rate.endsWith("pt")).length !== 4
    ) {
      throw new Error(`unexpected comparison rates: ${rates.join(",")}`);
    }
    const layout = await page.evaluate(() => {
      const selectors = [
        ".board-shell",
        ".hand",
        ".model-comparisons",
        ".control-actions",
      ];
      const elements = [
        ...selectors.map((selector) => document.querySelector(selector)),
        ...document.querySelectorAll(".comparison-cards button"),
      ].filter(Boolean);
      const outside = elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            className: element.className,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          };
        })
        .filter(
          (rect) =>
            rect.top < -1 ||
            rect.left < -1 ||
            rect.right > window.innerWidth + 1 ||
            rect.bottom > window.innerHeight + 1,
        );
      const rowTops = [
        ...document.querySelectorAll(".model-comparison"),
      ].map((element) =>
        Math.round(element.getBoundingClientRect().top),
      );
      return {
        viewport: [window.innerWidth, window.innerHeight],
        scroll: [
          document.documentElement.scrollWidth,
          document.documentElement.scrollHeight,
        ],
        outside,
        rowTops,
        titledPlans: document.querySelectorAll(
          ".comparison-cards small[title]:not([title=''])",
        ).length,
      };
    });
    if (
      layout.scroll[0] > layout.viewport[0] + 1 ||
      layout.scroll[1] > layout.viewport[1] + 1 ||
      layout.outside.length ||
      new Set(layout.rowTops).size !== 5 ||
      layout.titledPlans !== 20
    ) {
      throw new Error(`comparison does not fit 1280x940: ${JSON.stringify(layout)}`);
    }
    const downloadPromise = page.waitForEvent("download");
    await comparison
      .getByText("検証データをダウンロード", { exact: true })
      .click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    if (!downloadedPath) throw new Error("analysis JSON was not downloaded");
    const audit = JSON.parse(await readFile(downloadedPath, "utf8"));
    if (
      audit.schemaVersion !== 2 ||
      audit.modelResults?.length !== 5 ||
      audit.modelResults.some((model) => model.status !== "ok") ||
      audit.modelResults.some((model) => model.aiTop3?.length !== 3) ||
      !audit.turnStartState?.players ||
      audit.runtime?.registry?.models?.length < audit.modelResults.length ||
      !audit.v2Tracking?.negativePiles
    ) {
      throw new Error("analysis JSON is missing reproducibility data");
    }
    const firstModelCandidates = comparison
      .locator(".model-comparison")
      .first()
      .locator(".comparison-cards button");
    await firstModelCandidates.nth(1).click();
    await page.screenshot({
      path: "test-artifacts/analysis-comparison-1280x940.png",
      fullPage: true,
    });
    await firstModelCandidates.first().click();
    const startedAt = Date.now();
    await page.getByText("表示中の手でプレイ", { exact: true }).click();
    await page
      .locator(".score-strip article")
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(
      () =>
        document
          .querySelector(".score-strip article:first-child")
          ?.classList.contains("active-player"),
      undefined,
      { timeout: 60_000 },
    );
    console.log(`expert NPC round: ${Date.now() - startedAt}ms`);
    await page.reload({ waitUntil: "networkidle" });
    if (!(await page.getByText("強化NPC", { exact: true }).first().isVisible())) {
      throw new Error("saved difficulty was not restored");
    }
    await page.getByText("続きから", { exact: true }).click();
    if (
      !(await page
        .locator(".score-strip article")
        .first()
        .evaluate((element) => element.classList.contains("active-player")))
    ) {
      throw new Error("saved turn was not restored");
    }

    await page.evaluate(() => {
      const key = "yellowstone-browser:game:v2";
      const saved = JSON.parse(localStorage.getItem(key));
      saved.state.players[0].hand = [saved.state.players[0].hand[0]];
      saved.state.currentPlayerIndex = 0;
      saved.state.phase = "play";
      saved.state.cardsPlayedThisTurn = 0;
      saved.settings = { difficulty: "standard", assistMode: "none" };
      localStorage.setItem(key, JSON.stringify(saved));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("続きから", { exact: true }).click();
    await page.locator(".hand-card").first().click();
    await page.locator(".board-cell.is-legal").first().click();
    await page.getByText("補充方法を選択", { exact: true }).waitFor();
    await page.getByText("山札から補充", { exact: true }).click();
    await page.getByText("1枚プレイで終える", { exact: true }).click();
    await page.waitForFunction(
      () => {
        const saved = JSON.parse(
          localStorage.getItem("yellowstone-browser:game:v2"),
        );
        return saved?.state?.lastTurnPlayCounts?.[0] === 1;
      },
      undefined,
      { timeout: 30_000 },
    );
  } else {
    throw new Error(await unavailable.textContent());
  }

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "browser smoke passed: analysis comparison, move confirmation, and one-card refill",
  );
} finally {
  await browser.close();
}
