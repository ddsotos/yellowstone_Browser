import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

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

  await page.getByText("expert", { exact: true }).click();
  await page.getByText("analysis", { exact: true }).click();

  const modelOptions = page.locator(".model-picker").last().locator("input[type=checkbox]");
  if ((await modelOptions.count()) !== 3) {
    throw new Error("expected exactly three selectable analysis models");
  }
  for (let index = 0; index < 3; index += 1) {
    if (!(await modelOptions.nth(index).isChecked())) {
      throw new Error("all three analysis models should default to selected");
    }
  }

  await page.getByText("New game", { exact: true }).click();
  await page.locator(".board-shell").waitFor({ state: "visible" });
  await page.locator(".hand-card").first().waitFor({ state: "visible" });
  await mkdir("test-artifacts", { recursive: true });
  await page.screenshot({
    path: "test-artifacts/browser-smoke-1280x940.png",
    fullPage: true,
  });

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("browser smoke passed: three-model selection and game start");
} finally {
  await browser.close();
}
