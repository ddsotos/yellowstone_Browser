import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";

const browser = await chromium.launch({
  executablePath:
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  await page.getByText("強化NPC", { exact: true }).click();
  await page.getByText("AI分析モード", { exact: true }).click();
  await page.getByText("新しいゲーム", { exact: true }).click();
  await page.locator(".hand-card").first().click();
  await page.locator(".board-cell.is-legal").first().click();
  await mkdir("test-artifacts", { recursive: true });
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
  await page.locator(".hand-card").first().click();
  await page.locator(".board-cell.is-legal").first().click();
  await page.locator(".frame-confirm").click();
  await page.getByText("補充しない", { exact: true }).click();

  const comparison = page.locator(".comparison");
  const unavailable = page.getByText(
    /AI分析を利用できません|AI分析が10秒を超えました/,
  );
  await Promise.race([
    comparison.waitFor({ state: "visible", timeout: 45_000 }),
    unavailable.waitFor({ state: "visible", timeout: 45_000 }),
  ]);
  if (await comparison.isVisible()) {
    if (!(await comparison.getByText(/補充なし/).first().isVisible())) {
      throw new Error("refill choice was not included in move description");
    }
    const rates = await comparison.locator("strong").allTextContents();
    if (rates.length !== 4 || rates.some((rate) => !rate.endsWith("%"))) {
      throw new Error(`unexpected comparison rates: ${rates.join(",")}`);
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
      audit.schemaVersion !== 1 ||
      audit.aiTop3?.length !== 3 ||
      !audit.turnStartState?.players ||
      !audit.playerSelection?.evaluation ||
      !audit.allAiCandidates?.length ||
      audit.model?.metadata?.valueSchema !== "yellowstone.value.v2" ||
      audit.model?.metadata?.contextShape?.[1] !== 300 ||
      !audit.v2Tracking?.negativePiles
    ) {
      throw new Error("analysis JSON is missing reproducibility data");
    }
    const candidateGroups = new Set(
      audit.aiTop3.map((value) => value.candidateGroupSignature),
    );
    if (candidateGroups.size !== 3) {
      throw new Error("AI top 3 contains duplicate card-and-refill groups");
    }
    await comparison.getByText("AI 1位", { exact: true }).click();
    await page.screenshot({
      path: "test-artifacts/analysis-comparison.png",
      fullPage: true,
    });
    await comparison.getByText("あなたの手", { exact: true }).click();
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
    await page.locator(".frame-confirm").click();
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
