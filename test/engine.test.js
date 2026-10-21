import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMPS,
  GameRuleError,
  PHASES,
  ROLES,
  WerewolfEngine,
} from "../src/engine.js";
import { RuleBot, runRuleBotGame } from "../src/ruleBot.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `P${index + 1}`,
  name: `玩家${index + 1}`,
  controller: index === 0 ? "human" : "bot",
}));

const roles = {
  P1: ROLES.SEER,
  P2: ROLES.WEREWOLF,
  P3: ROLES.WEREWOLF,
  P4: ROLES.VILLAGER,
  P5: ROLES.VILLAGER,
  P6: ROLES.VILLAGER,
};

function createEngine() {
  return new WerewolfEngine({ players, roles, rng: () => 0, maxDays: 6 });
}

function reachFirstDaySpeech(engine) {
  engine.start();
  engine.submitSeerCheck("P1", "P2");
  engine.resolveNight();
  assert.equal(engine.getStatus().phase, PHASES.DAY_SPEECH);
}

function finishSpeeches(engine) {
  while (engine.getStatus().phase === PHASES.DAY_SPEECH) {
    const speaker = engine.getStatus().currentSpeakerId;
    engine.submitSpeech(speaker, `${speaker} 发言`);
  }
}

function castVotes(engine, ballots) {
  for (const [actorId, targetId] of Object.entries(ballots)) {
    engine.submitVote(actorId, targetId);
  }
  assert.equal(engine.getStatus().phase, PHASES.VOTE_RESOLUTION);
}

function expectCode(code, action) {
  assert.throws(action, (error) => error instanceof GameRuleError && error.code === code);
}

test("规则机器人能完成整局模拟并生成解锁后的复盘", () => {
  const engine = createEngine();
  const bots = new Map(players.map((player) => [player.id, new RuleBot(player.id)]));
  const replay = runRuleBotGame(engine, bots);

  assert.equal(engine.getStatus().phase, PHASES.GAME_OVER);
  assert.ok([CAMPS.GOOD, CAMPS.WEREWOLF, "draw"].includes(replay.result.winner));
  assert.equal(Object.keys(replay.roles).length, 6);
  assert.ok(replay.events.some((event) => event.type === "GAME_ENDED"));
});

test("最高票平票时无人出局，并进入下一夜", () => {
  const engine = createEngine();
  reachFirstDaySpeech(engine);
  finishSpeeches(engine);
  castVotes(engine, {
    P1: "P4", P2: "P4", P3: "P4",
    P4: "P2", P5: "P2", P6: "P2",
  });

  const result = engine.resolveVote();
  assert.equal(result.tied, true);
  assert.equal(result.eliminatedId, null);
  assert.equal(engine.getStatus().phase, PHASES.SEER_CHECK);
  assert.ok(engine.observe("P4").players.every((player) => player.alive));
});

test("预言家出局不会直接结束游戏，下一夜跳过查验", () => {
  const engine = createEngine();
  reachFirstDaySpeech(engine);
  finishSpeeches(engine);
  castVotes(engine, {
    P1: "P2", P2: "P1", P3: "P1",
    P4: "P1", P5: "P1", P6: "P1",
  });

  const result = engine.resolveVote();
  assert.equal(result.eliminatedId, "P1");
  assert.equal(result.gameOver, false);
  assert.equal(engine.getStatus().phase, PHASES.WOLF_ACTION);
  assert.equal(engine.observe("P1").action, null);
});

test("最后一名狼人出局时好人立即获胜", () => {
  const engine = createEngine();
  reachFirstDaySpeech(engine);
  finishSpeeches(engine);
  castVotes(engine, {
    P1: "P2", P2: "P1", P3: "P2",
    P4: "P2", P5: "P2", P6: "P2",
  });
  engine.resolveVote();

  engine.submitSeerCheck("P1", "P3");
  engine.submitWolfAttack("P3", "P4");
  engine.resolveNight();
  finishSpeeches(engine);
  castVotes(engine, {
    P1: "P3", P3: "P1", P5: "P3", P6: "P3",
  });
  const result = engine.resolveVote();

  assert.equal(result.eliminatedId, "P3");
  assert.equal(engine.getStatus().phase, PHASES.GAME_OVER);
  assert.equal(engine.getStatus().winner, CAMPS.GOOD);
  assert.equal(engine.getStatus().resultReason, "all_werewolves_eliminated");
});

test("存活狼人数达到好人数时狼人立即获胜", () => {
  const engine = createEngine();
  reachFirstDaySpeech(engine);
  finishSpeeches(engine);
  castVotes(engine, {
    P1: "P4", P2: "P4", P3: "P4",
    P4: "P2", P5: "P4", P6: "P4",
  });
  engine.resolveVote();

  engine.submitSeerCheck("P1", "P2");
  engine.submitWolfAttack("P2", "P5");
  engine.submitWolfAttack("P3", "P5");
  const result = engine.resolveNight();

  assert.equal(result.eliminatedId, "P5");
  assert.equal(result.gameOver, true);
  assert.equal(engine.getStatus().winner, CAMPS.WEREWOLF);
  assert.equal(engine.getStatus().resultReason, "werewolves_reached_parity");
});

test("拒绝越阶段行动、重复投票和对出局玩家操作", () => {
  const engine = createEngine();
  engine.start();
  expectCode("WRONG_PHASE", () => engine.submitVote("P1", "P2"));
  engine.submitSeerCheck("P1", "P2");
  engine.resolveNight();
  finishSpeeches(engine);

  engine.submitVote("P1", "P2");
  expectCode("DUPLICATE_ACTION", () => engine.submitVote("P1", "P3"));
  castVotes(engine, { P2: "P4", P3: "P4", P4: "P2", P5: "P4", P6: "P4" });
  engine.resolveVote();

  assert.equal(engine.observe("P4").viewer.alive, false);
  expectCode("PLAYER_DEAD", () => engine.submitSeerCheck("P1", "P4"));
});

test("观察数据按身份过滤，结束前不泄露完整身份或私密行动", () => {
  const engine = createEngine();
  engine.start();
  engine.submitSeerCheck("P1", "P2");

  const seerView = engine.observe("P1");
  const villagerView = engine.observe("P4");
  const wolfView = engine.observe("P2");

  assert.equal(seerView.seerChecks[1].result, CAMPS.WEREWOLF);
  assert.equal(villagerView.seerChecks, undefined);
  assert.equal(villagerView.wolfTeam, undefined);
  assert.deepEqual(wolfView.wolfTeam, ["P2", "P3"]);
  assert.equal(villagerView.players.find((player) => player.id === "P2").role, undefined);
  assert.equal(villagerView.events.some((event) => event.type === "SEER_CHECKED"), false);
  expectCode("REPLAY_LOCKED", () => engine.getReplay());
});
