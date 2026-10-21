import { validateBotDecision } from "../src/botDecision.js";
import { WerewolfEngine } from "../src/engine.js";

const baseUrl = process.env.MODEL_SMOKE_BASE_URL ?? "http://127.0.0.1:4173";
const players = Array.from({ length: 6 }, (_, index) => ({
  id: `P${index + 1}`,
  name: index === 0 ? "你" : `机器人 ${index + 1}`,
  controller: index === 0 ? "human" : "bot",
}));

const statusResponse = await fetch(`${baseUrl}/api/model/status`);
if (!statusResponse.ok) throw new Error(`模型状态接口返回 ${statusResponse.status}`);
const status = await statusResponse.json();
if (!status.configured) throw new Error("服务端大模型尚未配置，无法执行真实模式冒烟测试");

const engine = WerewolfEngine.createTeachingGame({ players, humanPlayerId: "P1", rng: () => 0.42 });
engine.start();
engine.submitSeerCheck("P1", "P2");
engine.resolveNight();
engine.submitSpeech("P1", "我会结合查验与公开发言继续判断。");
const actorId = players.slice(1).find((player) => engine.observe(player.id).action)?.id;
if (!actorId) throw new Error("没有找到可执行首日发言的机器人");

const observation = engine.observe(actorId);
const response = await fetch(`${baseUrl}/api/model/decision`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ observation }),
});
const body = await response.json();
if (!response.ok || !body.ok) throw new Error(body.message || `模型决策接口返回 ${response.status}`);
const decision = validateBotDecision(observation, body.decision);

console.log(JSON.stringify({
  ok: true,
  provider: status.provider,
  model: status.model,
  actorId,
  actionType: decision.type,
  legalOutput: true,
}, null, 2));
