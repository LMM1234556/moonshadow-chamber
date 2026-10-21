import { CAMPS, PHASES, ROLES } from "./engine.js";

export class RuleBot {
  constructor(playerId, { rng = Math.random } = {}) {
    if (typeof rng !== "function") throw new TypeError("规则机器人的 rng 必须是函数");
    this.playerId = playerId;
    this._rng = rng;
  }

  decide(observation) {
    const { action } = observation;
    if (!action) return null;

    switch (action.type) {
      case "seer_check":
        return {
          type: action.type,
          targetId: this._seerTarget(observation, action.targets),
        };
      case "wolf_attack":
        return { type: action.type, targetId: this._wolfAttackTarget(observation, action.targets) };
      case "speech":
        return { type: action.type, text: this._speech(observation) };
      case "vote":
        return { type: action.type, targetId: this._voteTarget(observation, action.targets) };
      default:
        throw new Error(`未知机器人行动：${action.type}`);
    }
  }

  _seerTarget(observation, targets) {
    const seen = new Set(
      Object.values(observation.seerChecks ?? {}).map((check) => check.targetId),
    );
    const unseen = targets.filter((targetId) => !seen.has(targetId));
    const candidates = unseen.length > 0 ? unseen : targets;
    return this._pickHighest(candidates, this._publicSuspicion(observation, candidates));
  }

  _wolfAttackTarget(observation, targets) {
    const scores = new Map(targets.map((targetId) => [targetId, 0]));
    const wolfTeam = new Set(observation.wolfTeam ?? []);

    for (const event of observation.events ?? []) {
      if (event.type === "PLAYER_SPOKE" && scores.has(event.actorId)) {
        if (String(event.text ?? "").includes("预言家")) {
          scores.set(event.actorId, scores.get(event.actorId) + 5);
        }
        if ([...wolfTeam].some((wolfId) => this._claimsCamp(event.text, wolfId, "werewolf"))) {
          scores.set(event.actorId, scores.get(event.actorId) + 7);
        }
      }
      if (event.type === "VOTE_RESOLVED") {
        for (const targetId of targets) {
          scores.set(targetId, scores.get(targetId) - Math.min(Number(event.counts?.[targetId]) || 0, 3) * 0.25);
        }
      }
    }
    return this._pickHighest(targets, scores);
  }

  _speech(observation) {
    if (observation.viewer.role === ROLES.SEER) {
      const checks = Object.values(observation.seerChecks ?? {});
      const latest = checks.at(-1);
      if (latest) {
        return `我是预言家，${latest.targetId} 的查验阵营是${latest.result === CAMPS.WEREWOLF ? "狼人" : "好人"}。`;
      }
    }
    if (observation.viewer.role === ROLES.WEREWOLF) {
      return "我先听大家的逻辑，投票会结合公开发言判断。";
    }
    return "目前信息有限，我会参考公开查验和票型投票。";
  }

  _voteTarget(observation, targets) {
    const wolfTeam = new Set(observation.wolfTeam ?? []);
    const candidates = observation.viewer.role === ROLES.WEREWOLF
      ? targets.filter((targetId) => !wolfTeam.has(targetId))
      : targets;
    const scores = this._publicSuspicion(observation, candidates);

    if (observation.viewer.role === ROLES.SEER) {
      for (const check of Object.values(observation.seerChecks ?? {})) {
        if (!scores.has(check.targetId)) continue;
        scores.set(check.targetId, scores.get(check.targetId)
          + (check.result === CAMPS.WEREWOLF ? 100 : -100));
      }
    }
    if (observation.viewer.role === ROLES.WEREWOLF) {
      for (const event of observation.events ?? []) {
        if (event.type !== "PLAYER_SPOKE" || !scores.has(event.actorId)) continue;
        if ([...wolfTeam].some((wolfId) => this._claimsCamp(event.text, wolfId, "werewolf"))) {
          scores.set(event.actorId, scores.get(event.actorId) + 5);
        }
      }
    }
    return this._pickHighest(candidates, scores);
  }

  _publicSuspicion(observation, targets) {
    const scores = new Map(targets.map((targetId) => [targetId, 0]));
    for (const event of observation.events ?? []) {
      if (event.type === "PLAYER_SPOKE") {
        for (const targetId of targets) {
          if (this._claimsCamp(event.text, targetId, "werewolf")) {
            scores.set(targetId, scores.get(targetId) + 3);
          } else if (this._claimsCamp(event.text, targetId, "good")) {
            scores.set(targetId, scores.get(targetId) - 2);
          }
        }
      }
      if (event.type === "VOTE_RESOLVED") {
        for (const targetId of targets) {
          scores.set(targetId, scores.get(targetId) + Math.min(Number(event.counts?.[targetId]) || 0, 3) * 0.35);
        }
      }
    }
    return scores;
  }

  _claimsCamp(text, targetId, camp) {
    const compact = String(text ?? "").replace(/\s+/g, "");
    const start = compact.indexOf(String(targetId));
    if (start < 0) return false;
    const claim = compact.slice(start, start + String(targetId).length + 18);
    return camp === "werewolf"
      ? /狼人|狼队/.test(claim)
      : /好人|金水/.test(claim);
  }

  _pickHighest(targets, scores) {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error("规则机器人没有合法候选目标");
    }
    const canonicalTargets = [...new Set(targets)]
      .sort((left, right) => String(left).localeCompare(String(right), "en", { numeric: true }));
    const highest = Math.max(...canonicalTargets.map((targetId) => scores.get(targetId) ?? 0));
    const tied = canonicalTargets.filter((targetId) => (scores.get(targetId) ?? 0) === highest);
    const roll = Math.min(1 - Number.EPSILON, Math.max(0, Number(this._rng()) || 0));
    return tied[Math.floor(roll * tied.length)];
  }
}

export function runRuleBotGame(engine, bots, { maxSteps = 200 } = {}) {
  if (engine.getStatus().phase === PHASES.NOT_STARTED) engine.start();

  let steps = 0;
  while (engine.getStatus().phase !== PHASES.GAME_OVER) {
    steps += 1;
    if (steps > maxSteps) throw new Error(`模拟超过 ${maxSteps} 步，可能存在状态机死循环`);

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
    for (const [playerId, bot] of bots.entries()) {
      const observation = engine.observe(playerId);
      const decision = bot.decide(observation);
      if (!decision) continue;

      acted = true;
      if (decision.type === "seer_check") {
        engine.submitSeerCheck(playerId, decision.targetId);
      } else if (decision.type === "wolf_attack") {
        engine.submitWolfAttack(playerId, decision.targetId);
      } else if (decision.type === "speech") {
        engine.submitSpeech(playerId, decision.text);
      } else if (decision.type === "vote") {
        engine.submitVote(playerId, decision.targetId);
      }
      break;
    }
    if (!acted) throw new Error(`阶段 ${status.phase} 没有机器人能执行合法行动`);
  }

  return engine.getReplay();
}
