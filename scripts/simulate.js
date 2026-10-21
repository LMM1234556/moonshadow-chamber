import { ROLES, WerewolfEngine } from "../src/engine.js";
import { RuleBot, runRuleBotGame } from "../src/ruleBot.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `P${index + 1}`,
  name: index === 0 ? "真人玩家（规则机器人代操作）" : `机器人${index + 1}`,
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

const engine = new WerewolfEngine({ players, roles, rng: () => 0 });
const bots = new Map(players.map((player) => [player.id, new RuleBot(player.id)]));
const replay = runRuleBotGame(engine, bots);

console.log("规则机器人整局模拟完成");
console.log(`结果：${replay.result.winner}（${replay.result.reason}）`);
console.log(`结束于：第 ${replay.result.day} 个白天 / 第 ${replay.result.night} 个夜晚`);
console.log(`存活玩家：${replay.survivors.join(", ")}`);
console.log("\n公开与私密事件复盘：");
for (const event of replay.events) {
  console.log(`${String(event.sequence).padStart(2, "0")}. ${event.type}`, event);
}
