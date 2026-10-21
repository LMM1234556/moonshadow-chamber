import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CAMPS, PHASES, ROLES, WerewolfEngine } from "../src/engine.js";
import { RuleBot } from "../src/ruleBot.js";

const PLAYER_IDS = Array.from({ length: 6 }, (_, index) => `P${index + 1}`);
const ROLE_POOL = [ROLES.SEER, ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER];
const HUMAN_ROLES = [ROLES.SEER, ROLES.WEREWOLF, ROLES.VILLAGER];

function option(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

const games = Number(option("games", "1000"));
const baseSeed = Number(option("seed", "20261021"));
const mode = option("mode", "compare");
const humanSeatOption = option("human-seat", "all");
const humanRoleOption = option("human-role", "all");
const outputPath = option("output", "");

if (!Number.isInteger(games) || games < 1) throw new Error("--games 必须是正整数");
if (!Number.isInteger(baseSeed)) throw new Error("--seed 必须是整数");
if (!["legacy", "current", "compare"].includes(mode)) throw new Error("--mode 必须是 legacy、current 或 compare");
if (humanSeatOption !== "all" && !/^[1-6]$/.test(humanSeatOption)) throw new Error("--human-seat 必须是 all 或 1—6");
if (humanRoleOption !== "all" && !HUMAN_ROLES.includes(humanRoleOption)) {
  throw new Error("--human-role 必须是 all、seer、werewolf 或 villager");
}

function mixSeed(...parts) {
  let hash = 2166136261;
  for (const character of parts.join("|").split("")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, rng) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(rng() * (index + 1));
    [copy[index], copy[selected]] = [copy[selected], copy[index]];
  }
  return copy;
}

function scenarioAt(index) {
  const seats = humanSeatOption === "all"
    ? PLAYER_IDS
    : [`P${humanSeatOption}`];
  const roles = humanRoleOption === "all"
    ? HUMAN_ROLES
    : [humanRoleOption];
  const combinations = seats.flatMap((humanId) => roles.map((humanRole) => ({ humanId, humanRole })));
  const selected = combinations[index % combinations.length];
  const seed = mixSeed(baseSeed, index);
  const remainingRoles = [...ROLE_POOL];
  remainingRoles.splice(remainingRoles.indexOf(selected.humanRole), 1);
  const shuffledRoles = shuffle(remainingRoles, mulberry32(mixSeed(seed, "roles")));
  const roleMap = { [selected.humanId]: selected.humanRole };
  PLAYER_IDS.filter((playerId) => playerId !== selected.humanId)
    .forEach((playerId, roleIndex) => {
      roleMap[playerId] = shuffledRoles[roleIndex];
    });
  return { ...selected, seed, roles: roleMap };
}

class LegacyRuleBot {
  decide(observation) {
    const { action } = observation;
    if (!action) return null;
    if (action.type === "seer_check") {
      const seen = new Set(Object.values(observation.seerChecks ?? {}).map((check) => check.targetId));
      return { type: action.type, targetId: action.targets.find((targetId) => !seen.has(targetId)) ?? action.targets[0] };
    }
    if (action.type === "wolf_attack") return { type: action.type, targetId: action.targets[0] };
    if (action.type === "speech") {
      if (observation.viewer.role === ROLES.SEER) {
        const latest = Object.values(observation.seerChecks ?? {}).at(-1);
        if (latest) {
          return { type: action.type, text: `我是预言家，${latest.targetId} 的查验阵营是${latest.result === CAMPS.WEREWOLF ? "狼人" : "好人"}。` };
        }
      }
      return {
        type: action.type,
        text: observation.viewer.role === ROLES.WEREWOLF
          ? "我先听大家的逻辑，投票会结合公开发言判断。"
          : "目前信息有限，我会参考公开查验和票型投票。",
      };
    }
    if (action.type === "vote") {
      if (observation.viewer.role === ROLES.SEER) {
        const checkedWolf = Object.values(observation.seerChecks ?? {})
          .find((check) => check.result === CAMPS.WEREWOLF && action.targets.includes(check.targetId));
        if (checkedWolf) return { type: action.type, targetId: checkedWolf.targetId };
      }
      if (observation.viewer.role === ROLES.WEREWOLF) {
        return { type: action.type, targetId: action.targets.find((targetId) => !observation.wolfTeam.includes(targetId)) };
      }
      return { type: action.type, targetId: action.targets[0] };
    }
    throw new Error(`未知机器人行动：${action.type}`);
  }
}

function applyDecision(engine, playerId, decision) {
  if (decision.type === "seer_check") engine.submitSeerCheck(playerId, decision.targetId);
  else if (decision.type === "wolf_attack") engine.submitWolfAttack(playerId, decision.targetId);
  else if (decision.type === "speech") engine.submitSpeech(playerId, decision.text);
  else if (decision.type === "vote") engine.submitVote(playerId, decision.targetId);
  else throw new Error(`未知行动：${decision.type}`);
}

function runScenario(scenario, variant) {
  const players = PLAYER_IDS.map((id) => ({
    id,
    name: `玩家${id.slice(1)}`,
    controller: id === scenario.humanId ? "human" : "bot",
  }));
  const engine = new WerewolfEngine({
    players,
    roles: scenario.roles,
    rng: mulberry32(mixSeed(scenario.seed, "engine", variant)),
  });
  const bots = new Map(players.map((player, index) => [
    player.id,
    variant === "legacy"
      ? new LegacyRuleBot()
      : new RuleBot(player.id, { rng: mulberry32(mixSeed(scenario.seed, "bot", index)) }),
  ]));
  let steps = 0;
  let illegalActions = 0;

  try {
    engine.start();
    while (engine.getStatus().phase !== PHASES.GAME_OVER) {
      steps += 1;
      if (steps > 200) throw new Error("STEP_LIMIT");
      const status = engine.getStatus();
      if (status.phase === PHASES.NIGHT_RESOLUTION) {
        engine.resolveNight();
        continue;
      }
      if (status.phase === PHASES.VOTE_RESOLUTION) {
        engine.resolveVote();
        continue;
      }
      let acted = false;
      for (const [playerId, bot] of bots) {
        const observation = engine.observe(playerId);
        const decision = bot.decide(observation);
        if (!decision) continue;
        acted = true;
        try {
          applyDecision(engine, playerId, decision);
        } catch (error) {
          illegalActions += 1;
          throw error;
        }
        break;
      }
      if (!acted) throw new Error(`NO_ACTION:${status.phase}`);
    }
    return { completed: true, illegalActions, replay: engine.getReplay(), scenario };
  } catch (error) {
    return { completed: false, illegalActions, error: error.code ?? error.message, scenario };
  }
}

function wilson(successes, sampleSize) {
  if (sampleSize === 0) return null;
  const z = 1.96;
  const rate = successes / sampleSize;
  const denominator = 1 + (z ** 2) / sampleSize;
  const center = (rate + (z ** 2) / (2 * sampleSize)) / denominator;
  const margin = z * Math.sqrt((rate * (1 - rate) / sampleSize) + (z ** 2) / (4 * sampleSize ** 2)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function proportion(successes, sampleSize) {
  return {
    successes,
    sampleSize,
    rate: sampleSize ? successes / sampleSize : null,
    ci95: wilson(successes, sampleSize),
  };
}

function mean(values) {
  if (values.length === 0) return { sampleSize: 0, value: null, ci95: null };
  const value = values.reduce((sum, item) => sum + item, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, item) => sum + ((item - value) ** 2), 0) / (values.length - 1)
    : 0;
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { sampleSize: values.length, value, ci95: [value - margin, value + margin] };
}

function summarize(results) {
  const completed = results.filter((result) => result.completed);
  const seats = Object.fromEntries(PLAYER_IDS.map((playerId) => [playerId, {
    attackEligible: 0,
    attacked: 0,
    attackBallots: 0,
    dayOneVotes: 0,
    dayOneBallots: 0,
    dayOneVoteRounds: 0,
    dayOneEliminated: 0,
  }]));
  const winners = { [CAMPS.GOOD]: 0, [CAMPS.WEREWOLF]: 0, draw: 0 };
  const rounds = [];

  for (const { replay, scenario } of completed) {
    winners[replay.result.winner] += 1;
    rounds.push(replay.events.filter((event) => event.type === "VOTE_RESOLVED").length);
    const dayOneVote = replay.events.find((event) => event.type === "VOTE_RESOLVED" && event.day === 1);
    if (dayOneVote) {
      for (const playerId of PLAYER_IDS) seats[playerId].dayOneVoteRounds += 1;
      for (const targetId of Object.values(dayOneVote.ballots)) {
        seats[targetId].dayOneVotes += 1;
        for (const playerId of PLAYER_IDS) seats[playerId].dayOneBallots += 1;
      }
      if (dayOneVote.eliminatedId) seats[dayOneVote.eliminatedId].dayOneEliminated += 1;
    }

    const firstAttackNight = replay.events
      .filter((event) => event.type === "WOLF_TARGET_SUBMITTED")
      .reduce((minimum, event) => Math.min(minimum, event.night), Number.POSITIVE_INFINITY);
    if (Number.isFinite(firstAttackNight)) {
      const nightStart = replay.events.find((event) => event.type === "NIGHT_STARTED" && event.night === firstAttackNight);
      const attackEvents = replay.events.filter((event) => event.type === "WOLF_TARGET_SUBMITTED" && event.night === firstAttackNight);
      const attacked = new Set(attackEvents.map((event) => event.targetId));
      const eliminatedBeforeNight = new Set(replay.events
        .filter((event) => event.type === "PLAYER_ELIMINATED" && event.sequence < nightStart.sequence)
        .map((event) => event.playerId));
      for (const playerId of PLAYER_IDS) {
        if (scenario.roles[playerId] !== ROLES.WEREWOLF && !eliminatedBeforeNight.has(playerId)) {
          seats[playerId].attackEligible += 1;
          if (attacked.has(playerId)) seats[playerId].attacked += 1;
        }
      }
      for (const event of attackEvents) seats[event.targetId].attackBallots += 1;
    }
  }

  const totalDayOneBallots = Object.values(seats).reduce((sum, seat) => sum + seat.dayOneVotes, 0);
  const totalAttackBallots = Object.values(seats).reduce((sum, seat) => sum + seat.attackBallots, 0);
  return {
    games: results.length,
    completeRate: proportion(completed.length, results.length),
    wins: {
      good: proportion(winners.good, completed.length),
      werewolf: proportion(winners.werewolf, completed.length),
      draw: proportion(winners.draw, completed.length),
    },
    averageDayRounds: mean(rounds),
    illegalActions: results.reduce((sum, result) => sum + result.illegalActions, 0),
    abnormalEnds: results.length - completed.length,
    abnormalReasons: results.filter((result) => !result.completed)
      .reduce((counts, result) => ({ ...counts, [result.error]: (counts[result.error] ?? 0) + 1 }), {}),
    seats: Object.fromEntries(PLAYER_IDS.map((playerId) => [playerId, {
      firstAttackTargetRate: proportion(seats[playerId].attacked, seats[playerId].attackEligible),
      firstAttackBallotShare: proportion(seats[playerId].attackBallots, totalAttackBallots),
      firstDayVoteShare: proportion(seats[playerId].dayOneVotes, totalDayOneBallots),
      firstDayEliminationRate: proportion(seats[playerId].dayOneEliminated, seats[playerId].dayOneVoteRounds),
    }])),
  };
}

const scenarios = Array.from({ length: games }, (_, index) => scenarioAt(index));
const variants = mode === "compare" ? ["legacy", "current"] : [mode];
const report = {
  configuration: {
    gamesPerVariant: games,
    baseSeed,
    mode,
    humanSeat: humanSeatOption,
    humanRole: humanRoleOption,
    humanControl: "规则机器人代理，用于无人值守公平性基线",
    firstAttackDefinition: "首个实际提交狼人袭击目标的夜晚；当前规则中为第2夜",
  },
  scenarioCoverage: scenarios.reduce((counts, scenario) => {
    const key = `${scenario.humanId}:${scenario.humanRole}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {}),
  variants: {},
};

for (const variant of variants) {
  report.variants[variant] = summarize(scenarios.map((scenario) => runScenario(scenario, variant)));
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

console.table(Object.entries(report.variants).map(([variant, summary]) => ({
  variant,
  games: summary.games,
  complete: percent(summary.completeRate.rate),
  goodWin: percent(summary.wins.good.rate),
  wolfWin: percent(summary.wins.werewolf.rate),
  draw: percent(summary.wins.draw.rate),
  averageRounds: summary.averageDayRounds.value?.toFixed(3),
  illegal: summary.illegalActions,
  abnormal: summary.abnormalEnds,
})));

for (const [variant, summary] of Object.entries(report.variants)) {
  console.log(`\n${variant}：各座位首次夜袭目标率 / 首日票数占比 / 首日被投出率`);
  console.table(Object.entries(summary.seats).map(([seat, metrics]) => ({
    seat,
    firstAttackTarget: percent(metrics.firstAttackTargetRate.rate),
    dayOneVoteShare: percent(metrics.firstDayVoteShare.rate),
    dayOneEliminated: percent(metrics.firstDayEliminationRate.rate),
  })));
}

if (outputPath) {
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n完整评测数据已写入：${absoluteOutput}`);
}
