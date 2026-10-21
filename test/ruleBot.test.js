import assert from "node:assert/strict";
import test from "node:test";
import { PHASES, ROLES, WerewolfEngine } from "../src/engine.js";
import { RuleBot } from "../src/ruleBot.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `P${index + 1}`,
  name: `玩家${index + 1}`,
}));

function equalEvidenceVote(targets) {
  return {
    viewer: { id: "P6", role: ROLES.VILLAGER, alive: true },
    action: { type: "vote", targets },
    events: [],
  };
}

test("同分目标的选择不依赖候选数组顺序", () => {
  const forward = new RuleBot("P6", { rng: () => 0.74 })
    .decide(equalEvidenceVote(["P1", "P2", "P3", "P4"]));
  const reversed = new RuleBot("P6", { rng: () => 0.74 })
    .decide(equalEvidenceVote(["P4", "P3", "P2", "P1"]));

  assert.equal(forward.targetId, "P3");
  assert.deepEqual(reversed, forward);
});

test("同分时注入的随机数可以覆盖所有候选，而非固定选择P1", () => {
  const targets = ["P1", "P2", "P3", "P4"];
  const selected = [0.01, 0.26, 0.51, 0.76].map((roll) =>
    new RuleBot("P6", { rng: () => roll }).decide(equalEvidenceVote(targets)).targetId);

  assert.deepEqual(selected, targets);
});

test("村民依据公开预言家声明投票，不读取隐藏身份", () => {
  const observation = {
    viewer: { id: "P4", role: ROLES.VILLAGER, alive: true },
    action: { type: "vote", targets: ["P1", "P2", "P3", "P5", "P6"] },
    players: players.map((player) => ({ ...player, alive: true })),
    events: [{ type: "PLAYER_SPOKE", actorId: "P1", text: "我是预言家，P2 的查验阵营是狼人。" }],
  };

  assert.equal(new RuleBot("P4", { rng: () => 0 }).decide(observation).targetId, "P2");
  assert.ok(observation.players.every((player) => player.role === undefined));
});

test("狼人夜袭优先处理公开威胁，而非第一个候选", () => {
  const observation = {
    viewer: { id: "P2", role: ROLES.WEREWOLF, alive: true },
    wolfTeam: ["P2", "P3"],
    action: { type: "wolf_attack", targets: ["P1", "P4", "P5", "P6"] },
    events: [{ type: "PLAYER_SPOKE", actorId: "P4", text: "我是预言家，P2 是狼人。" }],
  };

  assert.equal(new RuleBot("P2", { rng: () => 0 }).decide(observation).targetId, "P4");
});

test("首日公开查验能打破五名机器人集中投P1的回归问题", () => {
  const roles = {
    P1: ROLES.SEER,
    P2: ROLES.WEREWOLF,
    P3: ROLES.WEREWOLF,
    P4: ROLES.VILLAGER,
    P5: ROLES.VILLAGER,
    P6: ROLES.VILLAGER,
  };
  const engine = new WerewolfEngine({ players, roles, rng: () => 0 });
  const bots = new Map(players.map((player, index) => [
    player.id,
    new RuleBot(player.id, { rng: () => (index + 0.5) / players.length }),
  ]));
  engine.start();
  engine.submitSeerCheck("P1", "P2");
  engine.resolveNight();
  while (engine.getStatus().phase === PHASES.DAY_SPEECH) {
    const actorId = engine.getStatus().currentSpeakerId;
    engine.submitSpeech(actorId, bots.get(actorId).decide(engine.observe(actorId)).text);
  }

  const votes = Object.fromEntries(players.map((player) => [
    player.id,
    bots.get(player.id).decide(engine.observe(player.id)).targetId,
  ]));
  assert.deepEqual(votes, {
    P1: "P2",
    P2: "P1",
    P3: "P1",
    P4: "P2",
    P5: "P2",
    P6: "P2",
  });
});
