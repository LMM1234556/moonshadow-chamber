const ALLOWED_ACTIONS = new Set(["seer_check", "wolf_attack", "speech", "vote"]);

export class BotDecisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BotDecisionError";
    this.code = code;
  }
}

function plainString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function projectEvent(event) {
  const projected = {
    sequence: Number(event.sequence),
    type: plainString(event.type),
    day: Number(event.day),
    night: Number(event.night),
  };
  const allowedFields = [
    "actorId",
    "targetId",
    "playerId",
    "text",
    "skipped",
    "eliminatedId",
    "cause",
    "tied",
    "counts",
    "ballots",
    "winner",
    "reason",
    "protectedFirstNight",
    "role",
    "result",
  ];
  for (const field of allowedFields) {
    if (event[field] !== undefined) projected[field] = event[field];
  }
  return projected;
}

export function projectObservationForModel(observation) {
  if (!observation?.viewer || !observation?.status || !observation?.action) {
    throw new BotDecisionError("INVALID_OBSERVATION", "模型请求缺少玩家、阶段或行动信息");
  }
  const actionType = plainString(observation.action.type);
  if (!ALLOWED_ACTIONS.has(actionType)) {
    throw new BotDecisionError("INVALID_ACTION", "当前行动类型不能交给机器人");
  }

  const viewer = {
    id: plainString(observation.viewer.id),
    role: plainString(observation.viewer.role),
    camp: plainString(observation.viewer.camp),
    alive: observation.viewer.alive === true,
  };
  const action = actionType === "speech"
    ? { type: actionType, maxLength: Math.min(Number(observation.action.maxLength) || 100, 100) }
    : {
        type: actionType,
        targets: Array.isArray(observation.action.targets)
          ? observation.action.targets.filter((value) => typeof value === "string")
          : [],
      };

  return {
    viewer,
    status: {
      phase: plainString(observation.status.phase),
      day: Number(observation.status.day),
      night: Number(observation.status.night),
    },
    players: Array.isArray(observation.players)
      ? observation.players.map((player) => ({
          id: plainString(player.id),
          name: plainString(player.name),
          seat: Number(player.seat),
          alive: player.alive === true,
          ...(player.id === viewer.id && typeof player.role === "string"
            ? { role: player.role }
            : {}),
        }))
      : [],
    ...(viewer.role === "werewolf" && Array.isArray(observation.wolfTeam)
      ? { wolfTeam: observation.wolfTeam.filter((value) => typeof value === "string") }
      : {}),
    ...(viewer.role === "seer" && observation.seerChecks && typeof observation.seerChecks === "object"
      ? { seerChecks: observation.seerChecks }
      : {}),
    action,
    events: Array.isArray(observation.events)
      ? observation.events.slice(-30).map(projectEvent)
      : [],
  };
}

export function validateBotDecision(observation, decision) {
  const expected = observation?.action;
  if (!expected || !decision || typeof decision !== "object") {
    throw new BotDecisionError("INVALID_DECISION", "机器人没有返回可执行决策");
  }
  if (decision.type !== expected.type) {
    throw new BotDecisionError("ACTION_MISMATCH", "机器人输出的行动类型与当前阶段不一致");
  }

  if (expected.type === "speech") {
    if (typeof decision.text !== "string" || decision.text.trim().length === 0) {
      throw new BotDecisionError("INVALID_SPEECH", "机器人发言不能为空");
    }
    if (decision.text.length > expected.maxLength) {
      throw new BotDecisionError("SPEECH_TOO_LONG", "机器人发言超过长度限制");
    }
    return { type: expected.type, text: decision.text.trim() };
  }

  if (!Array.isArray(expected.targets) || !expected.targets.includes(decision.targetId)) {
    throw new BotDecisionError("ILLEGAL_TARGET", "机器人选择了合法候选之外的目标");
  }
  return { type: expected.type, targetId: decision.targetId };
}
