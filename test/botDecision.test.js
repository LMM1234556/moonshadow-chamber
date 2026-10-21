import assert from "node:assert/strict";
import test from "node:test";
import { ROLES, WerewolfEngine } from "../src/engine.js";
import {
  BotDecisionError,
  projectObservationForModel,
  validateBotDecision,
} from "../src/botDecision.js";
import { buildDecisionPrompt, modelConfiguration } from "../server/modelDecision.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `P${index + 1}`,
  name: `玩家${index + 1}`,
}));
const roles = {
  P1: ROLES.SEER,
  P2: ROLES.WEREWOLF,
  P3: ROLES.WEREWOLF,
  P4: ROLES.VILLAGER,
  P5: ROLES.VILLAGER,
  P6: ROLES.VILLAGER,
};

function expectDecisionCode(code, callback) {
  assert.throws(callback, (error) => error instanceof BotDecisionError && error.code === code);
}

test("模型投影只保留该角色已经可见的信息并忽略额外字段", () => {
  const engine = new WerewolfEngine({ players, roles, rng: () => 0 });
  engine.start();
  engine.submitSeerCheck("P1", "P2");
  engine.resolveNight();
  engine.submitSpeech("P1", "P2是狼人");
  const raw = engine.observe("P2");
  raw.secretRoleMatrix = roles;
  raw.players.find((player) => player.id === "P4").role = ROLES.VILLAGER;

  const projected = projectObservationForModel(raw);
  assert.equal(projected.secretRoleMatrix, undefined);
  assert.equal(projected.players.find((player) => player.id === "P4").role, undefined);
  assert.deepEqual(projected.wolfTeam, ["P2", "P3"]);
  assert.match(buildDecisionPrompt(projected), /P2是狼人/);
  assert.doesNotMatch(buildDecisionPrompt(projected), /secretRoleMatrix/);
});

test("程序拒绝错误行动类型、非法候选和超长发言", () => {
  const voteObservation = { action: { type: "vote", targets: ["P2", "P3"] } };
  assert.deepEqual(
    validateBotDecision(voteObservation, { type: "vote", targetId: "P2" }),
    { type: "vote", targetId: "P2" },
  );
  expectDecisionCode("ACTION_MISMATCH", () =>
    validateBotDecision(voteObservation, { type: "speech", text: "跳过" }));
  expectDecisionCode("ILLEGAL_TARGET", () =>
    validateBotDecision(voteObservation, { type: "vote", targetId: "P6" }));
  expectDecisionCode("SPEECH_TOO_LONG", () =>
    validateBotDecision(
      { action: { type: "speech", maxLength: 5 } },
      { type: "speech", text: "这是一段明显超过五个字的发言" },
    ));
});

test("模型配置不向客户端暴露密钥，并限制超时范围", () => {
  const config = modelConfiguration({
    DASHSCOPE_API_KEY: "secret-value",
    DASHSCOPE_BASE_URL: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    DASHSCOPE_MODEL: "current-model",
    MODEL_TIMEOUT_MS: "999999",
  });
  assert.deepEqual(config, {
    configured: true,
    provider: "aliyun-bailian",
    model: "current-model",
    timeoutMs: 30000,
    missing: [],
  });
  assert.equal(JSON.stringify(config).includes("secret-value"), false);
});

test("模型配置拒绝占位或非 HTTPS 的百炼地址", () => {
  for (const baseUrl of [
    "http://workspace.example.com/compatible-mode/v1",
    "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ]) {
    const config = modelConfiguration({
      DASHSCOPE_API_KEY: "secret-value",
      DASHSCOPE_BASE_URL: baseUrl,
      DASHSCOPE_MODEL: "current-model",
    });
    assert.equal(config.configured, false);
    assert.match(config.missing.join(" "), /DASHSCOPE_BASE_URL/);
  }
});
