import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

async function findAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("无法分配端到端测试端口"));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

const port = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const artifacts = resolve("artifacts");
const edgeCandidates = [
  resolve(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
  resolve(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft/Edge/Application/msedge.exe"),
];
const executablePath = edgeCandidates.find(existsSync);
if (!executablePath) throw new Error("未找到本机 Microsoft Edge，无法执行浏览器测试");

await mkdir(artifacts, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PORT: String(port),
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_BASE_URL: "",
    DASHSCOPE_MODEL: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/model/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error("本地服务器未在预期时间内就绪");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserErrors = [];
  const failedResources = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => failedResources.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert(await page.locator(".player-card").count() === 6, "玩家卡片数量不是6");
  assert(await page.locator(".portrait-media").count() === 6, "玩家肖像组件没有完整渲染");
  assert(await page.locator('.player-card.is-human[data-role="seer"]').count() === 1, "真人预言家身份没有正确分配");
  assert(await page.locator(".player-card:not(.is-human)[data-role]").count() === 0, "游戏结束前泄露了机器人身份");
  const portraitPositions = await page.locator(".portrait-media").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundPosition));
  assert(new Set(portraitPositions).size === 6, "六名玩家没有使用不同的中立肖像画面");
  const backgroundResponse = await page.request.get(`${baseUrl}/assets/backgrounds/moonlit-castle-hall.jpg`);
  assert(backgroundResponse.ok(), "月光古堡背景资源无法加载");
  const portraitResponse = await page.request.get(`${baseUrl}/assets/portraits/neutral-cast-atlas.jpg`);
  assert(portraitResponse.ok(), "中立人物肖像资源无法加载");
  assert(await page.locator(".action-panel").evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight), "1440×900 下当前行动区域没有进入首屏");
  assert(await page.locator("body").getAttribute("data-game-cycle") === "night", "首夜没有启用夜间场景");
  assert(await page.locator("#action-title").textContent() === "选择查验目标", "首个真人行动不是查验");
  assert(await page.locator('[data-command="confirm-target"]').isDisabled(), "未选择目标时确认按钮没有禁用");
  const disabledOpacity = Number(await page.locator('[data-command="confirm-target"]').evaluate((element) => getComputedStyle(element).opacity));
  assert(disabledOpacity < 1, "禁用按钮没有可识别的视觉反馈");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedTransition = await page.locator("#restart-button").evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration));
  assert(reducedTransition <= 0.001, "减少动态效果设置没有关闭过渡动画");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const firstTarget = page.locator("#player-grid [data-select-target]").first();
  const targetTransform = await firstTarget.evaluate((element) => getComputedStyle(element).transform);
  await firstTarget.hover();
  await page.waitForTimeout(180);
  const hoveredTransform = await firstTarget.evaluate((element) => getComputedStyle(element).transform);
  assert(hoveredTransform !== targetTransform, "可选玩家缺少悬停反馈");
  await firstTarget.focus();
  assert(await firstTarget.evaluate((element) => getComputedStyle(element).outlineStyle) !== "none", "键盘焦点缺少可见轮廓");
  await page.keyboard.press("Enter");
  assert(await firstTarget.getAttribute("aria-pressed") === "true", "选择玩家后席位没有高亮");
  assert(!(await page.locator('[data-command="confirm-target"]').isDisabled()), "选择玩家后确认按钮没有启用");
  assert((await page.locator(".selection-summary").textContent()).includes("机器人"), "选择目标后操作区没有立即更新目标名称");
  await page.waitForFunction(() => document.activeElement?.dataset.command === "confirm-target");
  assert(await page.locator('[data-command="confirm-target"]').evaluate((element) => element === document.activeElement), "键盘选择玩家后焦点没有移到确认操作");

  await page.locator("#bot-mode").selectOption("llm");
  assert((await page.locator("#notice").textContent()).includes("降级"), "未配置模型时没有显示降级说明");
  const apiResponse = await page.request.post(`${baseUrl}/api/model/decision`, {
    data: { observation: {} },
  });
  assert(apiResponse.status() === 503, "未配置模型时决策接口没有返回503");
  const apiBody = await apiResponse.json();
  assert(apiBody.code === "MODEL_NOT_CONFIGURED", "模型未配置错误码不正确");
  await page.locator("#bot-mode").selectOption("rule");

  await page.screenshot({ path: resolve(artifacts, "game-initial-desktop.png"), fullPage: true });

  await page.locator('[data-command="confirm-target"]').evaluate((button) => {
    button.click();
    button.click();
  });
  await page.locator("#busy-indicator").waitFor({ state: "visible", timeout: 2000 });
  assert(await page.locator(".button.is-loading").count() > 0, "确认行动后没有显示加载状态");
  await page.locator("#busy-indicator").waitFor({ state: "hidden", timeout: 20000 });
  await page.waitForFunction(() => document.body.dataset.gameCycle === "day");
  assert(await page.locator("#speech-input").isVisible(), "白天没有进入真人公开发言流程");
  assert(await page.locator('[data-command="speak"]').isDisabled(), "空白发言时提交按钮没有禁用");
  assert(await page.locator('[data-command="skip-speech"]').isVisible(), "空白发言没有独立的跳过入口");
  await page.locator("#speech-input").fill("   ");
  assert(await page.locator('[data-command="speak"]').isDisabled(), "纯空格发言仍可提交");
  await page.locator("#speech-input").fill("测".repeat(120));
  assert((await page.locator("#speech-input").inputValue()).length === 100, "发言输入没有限制为100字");
  assert((await page.locator("#character-count").textContent()).startsWith("100 / 100"), "发言字数提示不正确");
  await page.locator("#speech-input").fill("");
  assert((await page.locator(".player-card.is-current").textContent()).includes("你"), "当前发言玩家没有在席位上突出显示");
  assert((await page.locator("#table-focus-label").textContent()).includes("你"), "中央议事桌没有展示当前发言者");
  await page.screenshot({ path: resolve(artifacts, "game-day-desktop.png"), fullPage: true });

  let sawVotePhase = false;
  for (let step = 0; step < 40; step += 1) {
    if (await page.locator("#result-panel").isVisible()) break;
    const phase = await page.locator("body").getAttribute("data-game-phase");
    sawVotePhase ||= phase === "day_vote";
    const target = page.locator("#player-grid [data-select-target]").first();
    const confirmTarget = page.locator('#action-controls [data-command="confirm-target"]');
    const speech = page.locator("#speech-input");
    const advance = page.locator('#action-controls [data-command="advance"]');
    if (await target.isVisible().catch(() => false)) {
      assert(await page.locator(".player-card.is-out[data-select-target]").count() === 0, "出局玩家仍可作为操作目标");
      await target.click();
      assert(!(await confirmTarget.isDisabled()), "选择目标后确认按钮仍为禁用");
      await confirmTarget.click();
    } else if (await speech.isVisible().catch(() => false)) {
      await speech.fill("我是预言家，请结合我的查验与公开票型判断。");
      await page.locator('#action-controls [data-command="speak"]').click();
    } else if (await advance.isVisible().catch(() => false)) {
      await advance.click();
    } else {
      await page.waitForTimeout(120);
    }
    await page.locator("#busy-indicator").waitFor({ state: "hidden", timeout: 20000 });
  }

  assert(sawVotePhase, "整局浏览器流程没有经过投票阶段");
  assert(await page.locator("#result-panel").isVisible(), "40步内未完成整局游戏");
  assert(await page.locator("#role-reveal .result-player-card").count() === 6, "游戏结束后没有揭示全部6名玩家身份");
  assert(await page.locator("#result-panel").getAttribute("data-winner"), "结算区域没有真实获胜阵营状态");
  assert(await page.locator("#role-reveal .is-winner").count() > 0, "结算卡牌没有标识胜利阵营");
  const resultIntegrity = await page.locator("#result-panel").evaluate((panel) => {
    const winner = panel.dataset.winner;
    const cards = [...panel.querySelectorAll(".result-player-card")];
    const roles = cards.map((card) => card.querySelector(".result-role")?.textContent?.trim());
    const winningRoles = cards.filter((card) => card.classList.contains("is-winner"))
      .map((card) => card.querySelector(".result-role")?.textContent?.trim());
    return {
      roleCounts: {
        werewolf: roles.filter((role) => role === "狼人").length,
        seer: roles.filter((role) => role === "预言家").length,
        villager: roles.filter((role) => role === "村民").length,
      },
      winnerMatches: winner === "werewolf"
        ? winningRoles.length === 2 && winningRoles.every((role) => role === "狼人")
        : winner === "good"
          ? winningRoles.length === 4 && winningRoles.every((role) => role !== "狼人")
          : winningRoles.length === 0,
    };
  });
  assert(resultIntegrity.roleCounts.werewolf === 2 && resultIntegrity.roleCounts.seer === 1 && resultIntegrity.roleCounts.villager === 3, "结算身份数量与规则不一致");
  assert(resultIntegrity.winnerMatches, "结算胜利阵营与真实结果不一致");
  const compactLogRows = await page.locator("#event-list .event-row").count();
  assert(compactLogRows > 0 && compactLogRows <= 4, "日志默认没有限制为最新4条");
  assert(await page.locator("#log-history-toggle").isVisible(), "长日志没有提供展开历史入口");
  await page.locator("#log-history-toggle").click();
  assert((await page.locator("#event-list .event-row").count()) > compactLogRows, "展开历史后没有显示更多记录");
  const logScroll = await page.locator("#event-list").evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  assert(["auto", "scroll"].includes(logScroll.overflowY) && logScroll.scrollHeight > logScroll.clientHeight, "长局日志没有使用内部滚动");
  await page.locator("#public-log summary").click();
  assert(!(await page.locator("#public-log").getAttribute("open")), "公开日志无法折叠");
  await page.locator("#public-log summary").click();
  await page.screenshot({ path: resolve(artifacts, "game-result-desktop.png"), fullPage: true });
  await page.locator("#result-restart-button").click();
  assert(!(await page.locator("#result-panel").isVisible()), "重新开始后结算面板仍然可见");
  assert(await page.locator("#action-title").textContent() === "选择查验目标", "重新开始后没有回到首夜查验");
  assert(await page.locator(".player-card.is-out").count() === 0, "重新开始后仍有玩家处于出局状态");
  assert(await page.locator(".player-card:not(.is-human)[data-role]").count() === 0, "重新开始后泄露了机器人身份");
  assert(await page.locator("#event-list .event-row").count() === 1, "重新开始后旧对局日志没有清空");

  const viewportMatrix = [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
  ];
  let mobilePage;
  for (const viewport of viewportMatrix) {
    const viewportPage = await context.newPage();
    await viewportPage.setViewportSize(viewport);
    await viewportPage.goto(baseUrl, { waitUntil: "networkidle" });
    assert(await viewportPage.locator(".player-card").count() === 6, `${viewport.width}px 下玩家卡片没有完整渲染`);
    assert(await viewportPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${viewport.width}px 下出现横向滚动`);
    const actionPosition = await viewportPage.locator(".action-controls").evaluate((element) => getComputedStyle(element).position);
    assert(actionPosition !== "fixed" && actionPosition !== "sticky", `${viewport.width}px 下操作栏仍然覆盖页面内容`);
    const overlapsPlayerCard = await viewportPage.evaluate(() => {
      const action = document.querySelector(".action-controls")?.getBoundingClientRect();
      if (!action) return true;
      return [...document.querySelectorAll(".player-card")].some((card) => {
        const rect = card.getBoundingClientRect();
        return action.left < rect.right && action.right > rect.left && action.top < rect.bottom && action.bottom > rect.top;
      });
    });
    assert(!overlapsPlayerCard, `${viewport.width}px 下操作栏遮挡玩家卡片`);
    const confirmHeight = await viewportPage.locator('[data-command="confirm-target"]').evaluate((element) => element.getBoundingClientRect().height);
    assert(confirmHeight >= 44, `${viewport.width}px 下确认按钮触控高度不足（${confirmHeight}px）`);
    const undersizedButtons = await viewportPage.locator("button:visible").evaluateAll((buttons) => buttons
      .filter((button) => button.getBoundingClientRect().height < 44)
      .map((button) => `${button.textContent?.trim()}:${button.getBoundingClientRect().height}`));
    assert(undersizedButtons.length === 0, `${viewport.width}px 下存在触控高度不足的按钮：${undersizedButtons.join(", ")}`);
    if (viewport.width === 390) mobilePage = viewportPage;
    else await viewportPage.close();
  }

  await mobilePage.screenshot({ path: resolve(artifacts, "game-initial-mobile.png"), fullPage: true });
  const mobileTarget = mobilePage.locator("#player-grid [data-select-target]").first();
  await mobileTarget.click();
  assert(!(await mobilePage.locator('[data-command="confirm-target"]').isDisabled()), "移动端选择目标后确认按钮没有启用");
  await mobilePage.waitForFunction(() => {
    const rect = document.querySelector('[data-command="confirm-target"]')?.getBoundingClientRect();
    return rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  await mobilePage.screenshot({ path: resolve(artifacts, "game-selected-mobile.png"), fullPage: true });
  await mobilePage.locator('[data-command="confirm-target"]').click();
  await mobilePage.locator("#busy-indicator").waitFor({ state: "hidden", timeout: 20000 });
  assert(await mobilePage.locator("#speech-input").isVisible(), "移动端没有进入白天发言状态");
  assert(await mobilePage.locator("#speech-input").evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) >= 16, "移动端发言框字号可能触发浏览器自动缩放");
  await mobilePage.locator("#speech-input").focus();
  await mobilePage.setViewportSize({ width: 390, height: 520 });
  await mobilePage.waitForTimeout(320);
  const focusedInputVisible = await mobilePage.locator("#speech-input").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  assert(focusedInputVisible, "移动端可视高度缩小时发言框没有保持可见");
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await mobilePage.screenshot({ path: resolve(artifacts, "game-day-mobile.png"), fullPage: true });

  for (let step = 0; step < 40; step += 1) {
    if (await mobilePage.locator("#result-panel").isVisible()) break;
    const target = mobilePage.locator("#player-grid [data-select-target]").first();
    const confirmTarget = mobilePage.locator('#action-controls [data-command="confirm-target"]');
    const speech = mobilePage.locator("#speech-input");
    const advance = mobilePage.locator('#action-controls [data-command="advance"]');
    if (await target.isVisible().catch(() => false)) {
      await target.click();
      await confirmTarget.click();
    } else if (await speech.isVisible().catch(() => false)) {
      await mobilePage.locator('#action-controls [data-command="skip-speech"]').click();
    } else if (await advance.isVisible().catch(() => false)) {
      await advance.click();
    } else {
      await mobilePage.waitForTimeout(120);
    }
    await mobilePage.locator("#busy-indicator").waitFor({ state: "hidden", timeout: 20000 });
  }
  assert(await mobilePage.locator("#result-panel").isVisible(), "移动端40步内未完成整局游戏");
  assert(await mobilePage.locator("#role-reveal .result-player-card").count() === 6, "移动端结算没有展示全部身份卡牌");
  assert(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "移动端结算出现横向滚动");
  await mobilePage.waitForTimeout(800);
  await mobilePage.screenshot({ path: resolve(artifacts, "game-result-mobile.png"), fullPage: true });

  assert(browserErrors.length === 0, `浏览器控制台出现错误：${browserErrors.join(" | ")}`);
  assert(failedResources.length === 0, `页面资源加载失败：${failedResources.join(" | ")}`);
  console.log(JSON.stringify({
    ok: true,
    playerCards: 6,
    fullGameCompleted: true,
    rolesRevealed: 6,
    modelFallbackStatus: 503,
    browserErrors,
    failedResources,
    screenshots: [
      "artifacts/game-initial-desktop.png",
      "artifacts/game-day-desktop.png",
      "artifacts/game-result-desktop.png",
      "artifacts/game-initial-mobile.png",
      "artifacts/game-selected-mobile.png",
      "artifacts/game-day-mobile.png",
      "artifacts/game-result-mobile.png",
    ],
  }, null, 2));
} finally {
  await browser?.close();
  server.kill();
}
