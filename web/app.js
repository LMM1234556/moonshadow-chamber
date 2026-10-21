import { CAMPS, PHASES, ROLES, WerewolfEngine } from "/src/engine.js";
import { RuleBot } from "/src/ruleBot.js";
import { validateBotDecision } from "/src/botDecision.js";

const HUMAN_ID = "P1";
const PORTRAIT_ATLAS = "/assets/portraits/neutral-cast-atlas.jpg";
const portraitProfiles = [
  { src: PORTRAIT_ATLAS, size: "300% 200%", position: "0% 0%" },
  { src: PORTRAIT_ATLAS, size: "300% 200%", position: "50% 0%" },
  { src: PORTRAIT_ATLAS, size: "300% 200%", position: "100% 0%" },
  { src: PORTRAIT_ATLAS, size: "300% 200%", position: "0% 100%" },
  { src: PORTRAIT_ATLAS, size: "300% 200%", position: "50% 100%" },
  { src: PORTRAIT_ATLAS, size: "300% 200%", position: "100% 100%" },
];
const players = Array.from({ length: 6 }, (_, index) => ({
  id: `P${index + 1}`,
  name: index === 0 ? "你" : `机器人 ${index + 1}`,
  controller: index === 0 ? "human" : "bot",
  portrait: portraitProfiles[index % portraitProfiles.length],
}));

const phaseCopy = {
  [PHASES.NOT_STARTED]: ["准备开始", "6 人教学简化局", "你固定扮演预言家。首夜全员保护，最高票平票时无人出局。"],
  [PHASES.SEER_CHECK]: ["夜幕降临", "预言家查验", "选择一名存活玩家，查验结果仅你可见。"],
  [PHASES.WOLF_ACTION]: ["夜幕降临", "狼人秘密行动", "狼人正在分别选择袭击目标。"],
  [PHASES.NIGHT_RESOLUTION]: ["夜幕降临", "夜间结算", "系统正在依据规则结算夜间行动。"],
  [PHASES.DAY_SPEECH]: ["晨光初现", "存活玩家依次发言", "公开发言会成为后续玩家判断的依据。"],
  [PHASES.DAY_VOTE]: ["议事时刻", "公开投票", "选择一名其他存活玩家；所有票会在结算时一并公开。"],
  [PHASES.VOTE_RESOLUTION]: ["票型锁定", "投票结算", "最高票唯一时该玩家出局，最高票平票时无人出局。"],
  [PHASES.GAME_OVER]: ["本局结束", "身份揭晓", "完整身份和私密行动已进入复盘。"],
};

const roleNames = { [ROLES.SEER]: "预言家", [ROLES.WEREWOLF]: "狼人", [ROLES.VILLAGER]: "村民" };
const elements = Object.fromEntries([
  "bot-mode", "mode-status", "round-label", "phase-title", "phase-description",
  "busy-indicator", "restart-button", "notice", "player-grid", "action-title",
  "action-help", "private-info", "action-controls", "event-count", "event-list",
  "result-panel", "result-title", "result-description", "role-reveal", "result-restart-button",
  "table-phase-label", "table-focus-label", "log-history-toggle", "result-emblem", "result-camp-label",
].map((id) => [id, document.getElementById(id)]));

let engine;
let bots;
let busy = false;
let modelStatus = { configured: false, provider: "aliyun-bailian", model: null, timeoutMs: 8000 };
let selectedTargetId = null;
let logExpanded = false;
let previousCycle = null;
let phaseTransitionTimer = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function announce(message, tone = "info") {
  elements.notice.textContent = message;
  elements.notice.className = `notice${tone === "info" ? "" : ` is-${tone}`}`;
}

function playerName(id) {
  return players.find((player) => player.id === id)?.name ?? id ?? "无人";
}

function portraitStyleFor(playerId) {
  const portrait = players.find((player) => player.id === playerId)?.portrait ?? portraitProfiles[0];
  return `--portrait-image:url('${portrait.src}');--portrait-size:${portrait.size};--portrait-position:${portrait.position}`;
}

function createGame() {
  engine = WerewolfEngine.createTeachingGame({ players, humanPlayerId: HUMAN_ID });
  bots = new Map(players.slice(1).map((player) => [player.id, new RuleBot(player.id)]));
  selectedTargetId = null;
  logExpanded = false;
  engine.start();
  announce("新教学局已经开始。你是预言家，请完成首夜查验。");
  render();
}

function restartGame() {
  if (busy) return;
  createGame();
}

function modeLabel() {
  if (elements["bot-mode"].value === "rule") return "规则机器人";
  return modelStatus.configured ? `阿里云百炼 · ${modelStatus.model}` : "阿里云百炼 · 将自动降级";
}

function render() {
  const observation = engine.observe(HUMAN_ID);
  const status = observation.status;
  const legalTargets = observation.action?.targets ?? [];
  if (selectedTargetId && !legalTargets.includes(selectedTargetId)) selectedTargetId = null;
  document.body.dataset.gamePhase = status.phase;
  document.body.dataset.playerAction = observation.action?.type ?? "waiting";
  const gameCycle = status.phase.includes("night") || status.phase.includes("wolf") || status.phase.includes("seer")
    ? "night"
    : status.phase === PHASES.GAME_OVER ? "result" : "day";
  document.body.dataset.gameCycle = gameCycle;
  if (previousCycle && previousCycle !== gameCycle) {
    document.body.classList.remove("is-phase-transitioning");
    requestAnimationFrame(() => document.body.classList.add("is-phase-transitioning"));
    clearTimeout(phaseTransitionTimer);
    phaseTransitionTimer = setTimeout(() => document.body.classList.remove("is-phase-transitioning"), 720);
  }
  previousCycle = gameCycle;
  const [roundPrefix, title, description] = phaseCopy[status.phase];
  elements["round-label"].textContent = status.phase === PHASES.NOT_STARTED
    ? roundPrefix
    : `${roundPrefix} · 第 ${status.day || 1} 日 / 第 ${status.night} 夜`;
  elements["phase-title"].textContent = title;
  elements["phase-description"].textContent = description;
  elements["busy-indicator"].hidden = !busy;
  elements["restart-button"].disabled = busy;
  elements["bot-mode"].disabled = busy;
  elements["mode-status"].textContent = modeLabel();
  renderPlayers(observation);
  renderTableFocus(observation);
  renderPrivateInfo(observation);
  renderAction(observation);
  renderEvents(observation);
  renderResult(observation);
}

function seatPosition(index, total) {
  const angle = -90 + (360 / Math.max(total, 1)) * index;
  const radians = angle * Math.PI / 180;
  return {
    x: 50 + Math.cos(radians) * 35,
    y: 50 + Math.sin(radians) * 34,
  };
}

function renderPlayers(observation) {
  const targets = new Set(observation.action?.targets ?? []);
  const speechPhase = observation.status.phase === PHASES.DAY_SPEECH;
  const spokenPlayers = new Set(observation.events
    .filter((event) => event.type === "PLAYER_SPOKE" && event.day === observation.status.day)
    .map((event) => event.actorId));
  elements["player-grid"].innerHTML = observation.players.map((player, index) => {
    const current = player.id === observation.status.currentSpeakerId;
    const spoken = speechPhase && spokenPlayers.has(player.id);
    const waitingToSpeak = speechPhase && player.alive && !current && !spoken;
    const selectable = !busy && targets.has(player.id);
    const selected = selectable && player.id === selectedTargetId;
    const classes = [
      "player-card",
      player.id === HUMAN_ID ? "is-human" : "",
      !player.alive ? "is-out" : "",
      current ? "is-current" : "",
      spoken ? "has-spoken" : "",
      waitingToSpeak ? "is-waiting-to-speak" : "",
      selectable ? "is-selectable" : "",
      selected ? "is-selected" : "",
    ].filter(Boolean).join(" ");
    const role = player.role ? roleNames[player.role] : "身份隐藏";
    const publicState = !player.alive
      ? "已出局"
      : current ? "正在发言"
        : spoken ? "今日已发言"
          : waitingToSpeak ? "等待发言" : "仍在场上";
    const position = seatPosition(index, observation.players.length);
    const tag = selectable ? "button" : "article";
    const interactionAttributes = selectable
      ? `type="button" data-select-target="${escapeHtml(player.id)}" aria-pressed="${selected}" aria-label="选择 ${escapeHtml(player.name)}，${publicState}"`
      : "";
    const portraitStyle = portraitStyleFor(player.id);
    return `
      <${tag} class="${classes}" ${interactionAttributes}
        style="--seat-x:${position.x.toFixed(2)}%;--seat-y:${position.y.toFixed(2)}%;--seat-delay:${index * 35}ms"
        data-player-state="${player.alive ? "alive" : "out"}"${player.role ? ` data-role="${escapeHtml(player.role)}"` : ""}>
        <span class="player-avatar" aria-hidden="true">
          <span class="portrait-placeholder"><i></i><b></b><em></em></span>
          <span class="portrait-media" style="${portraitStyle}"></span>
          <span class="portrait-vignette"></span>
        </span>
        <span class="player-identity">
          <span class="seat">席位 ${String(player.seat).padStart(2, "0")}</span>
          <strong>${escapeHtml(player.name)}</strong>
          <span class="player-meta">${publicState}</span>
        </span>
        <span class="player-flags">
          ${player.id === HUMAN_ID ? '<span class="self-chip">本人</span>' : ""}
          <span class="role-chip">${escapeHtml(role)}</span>
        </span>
        ${selected ? '<span class="selected-mark">已选择</span>' : ""}
        ${!player.alive ? '<span class="out-mark">已出局</span>' : ""}
      </${tag}>`;
  }).join("");
}

function renderTableFocus(observation) {
  const action = observation.action;
  elements["table-phase-label"].textContent = phaseCopy[observation.status.phase][1];
  if (observation.status.phase === PHASES.DAY_SPEECH && observation.status.currentSpeakerId) {
    const speaker = playerName(observation.status.currentSpeakerId);
    elements["table-focus-label"].textContent = observation.status.currentSpeakerId === HUMAN_ID
      ? "轮到你公开发言"
      : `${speaker} 正在发言`;
  } else if (busy) {
    elements["table-focus-label"].textContent = "机器人正在完成行动";
  } else if (observation.status.phase === PHASES.GAME_OVER) {
    elements["table-focus-label"].textContent = "身份已经揭晓";
  } else if (selectedTargetId) {
    elements["table-focus-label"].textContent = `已选择 ${playerName(selectedTargetId)}`;
  } else if (action?.type === "seer_check") {
    elements["table-focus-label"].textContent = "请选择一名查验目标";
  } else if (action?.type === "vote") {
    elements["table-focus-label"].textContent = "请选择一名投票目标";
  } else if (!observation.viewer.alive) {
    elements["table-focus-label"].textContent = "你已出局，正在观战";
  } else {
    elements["table-focus-label"].textContent = "等待议事继续";
  }
}

function renderPrivateInfo(observation) {
  const checks = Object.entries(observation.seerChecks ?? {});
  const latest = checks.at(-1);
  elements["private-info"].innerHTML = `
    <div class="private-card">
      <span class="identity-emblem" aria-hidden="true">◐</span>
      <span>
        <small>你的身份</small>
        <strong>预言家</strong>
        <em>${latest
          ? `最近查验：${escapeHtml(playerName(latest[1].targetId))} 属于${latest[1].result === CAMPS.WEREWOLF ? "狼人" : "好人"}阵营`
          : "查验结果仅对你可见"}</em>
      </span>
    </div>`;
}

function renderAction(observation) {
  const { action, status } = observation;
  const controls = elements["action-controls"];
  if (busy) {
    elements["action-title"].textContent = "机器人行动中";
    elements["action-help"].textContent = `当前使用：${modeLabel()}。完成后会停在你的下一次合法行动。`;
    controls.innerHTML = '<button class="button button-primary is-loading" type="button" disabled><span class="spinner" aria-hidden="true"></span>等待行动完成</button>';
    return;
  }
  if (status.phase === PHASES.GAME_OVER) {
    elements["action-title"].textContent = "本局已经结束";
    elements["action-help"].textContent = "下方已展示胜负结果与全部身份。";
    controls.innerHTML = '<button class="button button-primary" type="button" data-command="restart">重新开始</button>';
    return;
  }
  if (!observation.viewer.alive) {
    elements["action-title"].textContent = "你已出局，进入观战";
    elements["action-help"].textContent = "点击继续，由机器人完成剩余游戏。";
    controls.innerHTML = '<button class="button button-primary" type="button" data-command="advance">继续观战</button>';
    return;
  }
  if (!action) {
    elements["action-title"].textContent = "等待其他玩家";
    elements["action-help"].textContent = "推进后，机器人会依次执行合法行动。";
    controls.innerHTML = '<button class="button button-primary" type="button" data-command="advance">推进机器人行动</button>';
    return;
  }
  if (action.type === "seer_check") {
    elements["action-title"].textContent = "选择查验目标";
    elements["action-help"].textContent = "先在议事桌选择玩家，再确认查验。结果只对你可见。";
    controls.innerHTML = `
      <div class="selection-summary" aria-live="polite">
        <span>查验目标</span>
        <strong>${selectedTargetId ? escapeHtml(playerName(selectedTargetId)) : "尚未选择"}</strong>
      </div>
      <button class="button button-primary" type="button" data-command="confirm-target" data-action="seer_check" ${selectedTargetId ? "" : "disabled"}>
        确认查验
      </button>`;
  } else if (action.type === "vote") {
    elements["action-title"].textContent = "提交今日投票";
    elements["action-help"].textContent = "先在议事桌选择玩家，再确认投票。提交后不能修改。";
    controls.innerHTML = `
      <div class="selection-summary" aria-live="polite">
        <span>投票目标</span>
        <strong>${selectedTargetId ? escapeHtml(playerName(selectedTargetId)) : "尚未选择"}</strong>
      </div>
      <button class="button button-primary" type="button" data-command="confirm-target" data-action="vote" ${selectedTargetId ? "" : "disabled"}>
        确认投票
      </button>`;
  } else if (action.type === "speech") {
    elements["action-title"].textContent = "轮到你发言";
    elements["action-help"].textContent = "输入内容后提交；如不想公开信息，可明确选择跳过。最多100字。";
    controls.innerHTML = `
      <textarea id="speech-input" maxlength="100" aria-label="你的公开发言" placeholder="输入你的判断……"></textarea>
      <div id="character-count" class="character-count">0 / 100</div>
      <div class="speech-actions">
        <button class="button button-secondary" type="button" data-command="skip-speech">跳过发言</button>
        <button class="button button-primary" type="button" data-command="speak" disabled>提交发言</button>
      </div>`;
    const input = document.getElementById("speech-input");
    input.addEventListener("input", () => {
      document.getElementById("character-count").textContent = `${input.value.length} / 100`;
      controls.querySelector('[data-command="speak"]').disabled = input.value.trim().length === 0;
    });
    input.addEventListener("focus", () => {
      if (!window.matchMedia("(max-width: 760px)").matches) return;
      requestAnimationFrame(keepFocusedSpeechInputVisible);
      setTimeout(keepFocusedSpeechInputVisible, 260);
    });
  }
}

function keepFocusedSpeechInputVisible() {
  const input = document.getElementById("speech-input");
  if (!input || document.activeElement !== input) return;
  input.scrollIntoView({ behavior: "auto", block: "center" });
}

function eventText(event) {
  switch (event.type) {
    case "GAME_STARTED": return "教学局开始，身份已经私下分配。";
    case "SEER_CHECKED": return `你查验了 <strong>${escapeHtml(playerName(event.targetId))}</strong>：${event.result === CAMPS.WEREWOLF ? "狼人" : "好人"}阵营。`;
    case "NIGHT_RESOLVED": return event.eliminatedId
      ? `夜间结束，<strong>${escapeHtml(playerName(event.eliminatedId))}</strong> 出局。`
      : "夜间结束，今晚无人出局。";
    case "DAY_STARTED": return `第 ${event.day} 个白天开始。`;
    case "PLAYER_SPOKE": return `<strong>${escapeHtml(playerName(event.actorId))}</strong>：${event.skipped ? "（跳过发言）" : escapeHtml(event.text)}`;
    case "VOTE_RESOLVED": return event.tied
      ? "最高票平票，本轮无人出局。"
      : `投票结束，<strong>${escapeHtml(playerName(event.eliminatedId))}</strong> 出局。`;
    case "NIGHT_STARTED": return `第 ${event.night} 夜开始。`;
    case "PLAYER_ELIMINATED": return `${escapeHtml(playerName(event.playerId))} 因${event.cause === "day_vote" ? "投票" : "夜袭"}出局。`;
    case "GAME_ENDED": return `游戏结束：${event.winner === CAMPS.GOOD ? "好人阵营获胜" : event.winner === CAMPS.WEREWOLF ? "狼人阵营获胜" : "平局"}。`;
    default: return null;
  }
}

function eventPresentation(event) {
  if (event.type === "PLAYER_SPOKE") return { kind: "speech", icon: "“", label: "发言" };
  if (event.type === "VOTE_RESOLVED" || event.type === "VOTE_SUBMITTED") return { kind: "vote", icon: "◇", label: "投票" };
  if (event.type === "PLAYER_ELIMINATED") return { kind: "elimination", icon: "×", label: "出局" };
  if (event.type === "NIGHT_RESOLVED" && event.eliminatedId) return { kind: "elimination", icon: "×", label: "夜间出局" };
  if (event.type === "SEER_CHECKED") return { kind: "private", icon: "◐", label: "私密查验" };
  if (event.type === "GAME_ENDED") return { kind: "result", icon: "✦", label: "结算" };
  return { kind: "cycle", icon: event.type === "NIGHT_STARTED" ? "☾" : "☼", label: "阶段变化" };
}

function renderEvents(observation) {
  const events = observation.events.filter((event) => eventText(event));
  const visibleEvents = logExpanded ? events : events.slice(-4);
  elements["event-count"].textContent = events.length > visibleEvents.length
    ? `最新 ${visibleEvents.length} / 共 ${events.length} 条`
    : `${events.length} 条`;
  elements["event-list"].innerHTML = visibleEvents.length
    ? visibleEvents.map((event) => {
      const presentation = eventPresentation(event);
      return `
        <div class="event-row event-${presentation.kind}" role="listitem">
          <span class="event-marker" aria-label="${presentation.label}">${presentation.icon}</span>
          <div class="event-time">${event.day ? `第 ${event.day} 日` : `第 ${event.night} 夜`}</div>
          <div class="event-content">${eventText(event)}</div>
        </div>`;
    }).join("")
    : '<div class="empty-state">行动开始后，公开记录会显示在这里。</div>';
  elements["log-history-toggle"].hidden = events.length <= 4;
  elements["log-history-toggle"].textContent = logExpanded ? "收起历史记录" : `展开全部 ${events.length} 条记录`;
  elements["log-history-toggle"].setAttribute("aria-expanded", String(logExpanded));
}

function renderResult(observation) {
  const ended = observation.status.phase === PHASES.GAME_OVER;
  elements["result-panel"].hidden = !ended;
  if (!ended) return;
  elements["result-restart-button"].disabled = busy;
  const winner = observation.status.winner;
  elements["result-panel"].dataset.winner = winner ?? "draw";
  elements["result-emblem"].textContent = winner === CAMPS.WEREWOLF ? "☾" : winner === CAMPS.GOOD ? "✦" : "◇";
  elements["result-camp-label"].textContent = winner === CAMPS.GOOD
    ? "好人阵营 · 胜利"
    : winner === CAMPS.WEREWOLF ? "狼人阵营 · 胜利" : "本局平局";
  elements["result-title"].textContent = winner === CAMPS.GOOD
    ? "好人阵营获胜"
    : winner === CAMPS.WEREWOLF ? "狼人阵营获胜" : "达到回合上限，本局平局";
  elements["result-description"].textContent = winner === CAMPS.GOOD
    ? "两名狼人均已出局。"
    : winner === CAMPS.WEREWOLF ? "存活狼人数已经不少于存活好人数。" : "第六个白天结束后仍未分出胜负。";
  elements["role-reveal"].innerHTML = observation.players.map((player, index) => {
    const playerCamp = player.role === ROLES.WEREWOLF ? CAMPS.WEREWOLF : CAMPS.GOOD;
    const won = playerCamp === winner;
    return `
      <article class="result-player-card ${player.alive ? "is-survivor" : "is-eliminated"} ${won ? "is-winner" : "is-defeated"}"
        style="--result-delay:${index * 45}ms">
        <span class="player-avatar result-portrait" aria-hidden="true">
          <span class="portrait-placeholder"><i></i><b></b><em></em></span>
          <span class="portrait-media" style="${portraitStyleFor(player.id)}"></span>
          <span class="portrait-vignette"></span>
        </span>
        <span class="result-player-copy">
          <small>席位 ${String(player.seat).padStart(2, "0")}</small>
          <strong>${escapeHtml(player.name)}</strong>
          <span class="result-role">${escapeHtml(roleNames[player.role])}</span>
        </span>
        <span class="result-player-state">${player.alive ? "存活" : "出局"} · ${won ? "胜利阵营" : "失败阵营"}</span>
      </article>`;
  }).join("");
}

async function loadModelStatus() {
  try {
    const response = await fetch("/api/model/status", { cache: "no-store" });
    if (!response.ok) throw new Error("状态接口不可用");
    modelStatus = await response.json();
  } catch {
    modelStatus = { configured: false, provider: "aliyun-bailian", model: null, timeoutMs: 8000 };
  }
  render();
}

async function requestModel(observation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), modelStatus.timeoutMs + 1500);
  try {
    const response = await fetch("/api/model/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ observation }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || !body.ok) {
      const error = new Error(body.message || "模型请求失败");
      error.code = body.code || "MODEL_FAILURE";
      throw error;
    }
    return validateBotDecision(observation, body.decision);
  } finally {
    clearTimeout(timer);
  }
}

async function decideBot(playerId, observation) {
  const ruleDecision = () => bots.get(playerId).decide(observation);
  if (elements["bot-mode"].value !== "llm") return { decision: ruleDecision(), source: "规则机器人" };
  if (!modelStatus.configured) {
    return { decision: ruleDecision(), source: "规则机器人（大模型未配置）", fallback: true };
  }
  try {
    return { decision: await requestModel(observation), source: `阿里云百炼 · ${modelStatus.model}` };
  } catch (error) {
    return { decision: ruleDecision(), source: `规则机器人（${error.code === "MODEL_TIMEOUT" || error.name === "AbortError" ? "模型超时" : "模型失败"}降级）`, fallback: true };
  }
}

function applyDecision(playerId, decision) {
  if (decision.type === "seer_check") engine.submitSeerCheck(playerId, decision.targetId);
  else if (decision.type === "wolf_attack") engine.submitWolfAttack(playerId, decision.targetId);
  else if (decision.type === "speech") engine.submitSpeech(playerId, decision.text);
  else if (decision.type === "vote") engine.submitVote(playerId, decision.targetId);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function setButtonPending(button, label) {
  button.disabled = true;
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
}

async function advanceUntilHuman() {
  if (busy) return;
  busy = true;
  render();
  let usedFallback = false;
  try {
    for (let step = 0; step < 120; step += 1) {
      const status = engine.getStatus();
      if (status.phase === PHASES.GAME_OVER) break;
      if (engine.observe(HUMAN_ID).action) break;

      if (status.phase === PHASES.NIGHT_RESOLUTION) {
        engine.resolveNight();
      } else if (status.phase === PHASES.VOTE_RESOLUTION) {
        engine.resolveVote();
      } else {
        let acted = false;
        for (const [playerId] of bots) {
          const observation = engine.observe(playerId);
          if (!observation.action) continue;
          const result = await decideBot(playerId, observation);
          try {
            applyDecision(playerId, result.decision);
          } catch {
            const fallback = bots.get(playerId).decide(engine.observe(playerId));
            applyDecision(playerId, fallback);
            result.source = "规则机器人（非法模型输出降级）";
            result.fallback = true;
          }
          usedFallback ||= Boolean(result.fallback);
          announce(`${playerName(playerId)} 已完成行动 · ${result.source}`, result.fallback ? "warning" : "info");
          acted = true;
          break;
        }
        if (!acted) throw new Error(`阶段 ${status.phase} 没有可执行行动`);
      }
      render();
      await wait(180);
    }
    if (usedFallback) announce("本轮至少一次模型请求失败或不可用，相关行动已由规则机器人完成。", "warning");
  } catch (error) {
    announce(`推进失败：${error.message}`, "error");
  } finally {
    busy = false;
    render();
  }
}

async function handleHumanAction(action, value, successOverride = null) {
  try {
    if (action === "seer_check") engine.submitSeerCheck(HUMAN_ID, value);
    else if (action === "vote") engine.submitVote(HUMAN_ID, value);
    else if (action === "speech") engine.submitSpeech(HUMAN_ID, value);
    const successMessage = successOverride ?? (action === "seer_check"
      ? "查验已经确认，结果已写入你的私密身份卡。"
      : action === "vote" ? "投票已经提交，正在等待其他玩家。" : "发言已经公开提交。");
    selectedTargetId = null;
    render();
    announce(successMessage, "success");
    await advanceUntilHuman();
  } catch (error) {
    announce(`行动未执行：${error.message}`, "error");
    render();
  }
}

elements["player-grid"].addEventListener("click", (event) => {
  const target = event.target.closest("[data-select-target]");
  if (!target || busy) return;
  const keyboardActivation = event.detail === 0;
  selectedTargetId = target.dataset.selectTarget;
  render();
  if (keyboardActivation) {
    requestAnimationFrame(() => {
      elements["action-controls"].querySelector('[data-command="confirm-target"]')?.focus();
    });
  } else if (window.matchMedia("(max-width: 760px)").matches) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      elements["action-controls"].scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "center",
      });
    });
  }
});

elements["action-controls"].addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || busy) return;
  if (button.dataset.command === "confirm-target" && selectedTargetId) {
    setButtonPending(button, button.dataset.action === "vote" ? "正在提交投票" : "正在确认查验");
    await handleHumanAction(button.dataset.action, selectedTargetId);
  } else if (button.dataset.command === "speak") {
    const input = document.getElementById("speech-input");
    if (!input.value.trim()) {
      announce("发言内容不能为空；如需放弃本轮发言，请选择“跳过发言”。", "error");
      input.focus();
      return;
    }
    setButtonPending(button, "正在提交发言");
    await handleHumanAction("speech", input.value.trim());
  } else if (button.dataset.command === "skip-speech") {
    setButtonPending(button, "正在跳过发言");
    await handleHumanAction("speech", "", "你已跳过本轮发言。");
  } else if (button.dataset.command === "advance") {
    setButtonPending(button, "正在推进游戏");
    await advanceUntilHuman();
  } else if (button.dataset.command === "restart") {
    restartGame();
  }
});

elements["bot-mode"].addEventListener("change", () => {
  if (elements["bot-mode"].value === "llm" && !modelStatus.configured) {
    announce("已选择阿里云百炼模式，但服务端配置不完整；机器人行动会明确降级到规则策略。", "warning");
  } else {
    announce(`已切换为${modeLabel()}，从下一次机器人行动开始生效。`);
  }
  render();
});

elements["log-history-toggle"].addEventListener("click", () => {
  logExpanded = !logExpanded;
  renderEvents(engine.observe(HUMAN_ID));
});

window.visualViewport?.addEventListener("resize", keepFocusedSpeechInputVisible);
elements["restart-button"].addEventListener("click", restartGame);
elements["result-restart-button"].addEventListener("click", restartGame);

createGame();
loadModelStatus();
