export const ROLES = Object.freeze({
  SEER: "seer",
  WEREWOLF: "werewolf",
  VILLAGER: "villager",
});

export const CAMPS = Object.freeze({
  GOOD: "good",
  WEREWOLF: "werewolf",
});

export const PHASES = Object.freeze({
  NOT_STARTED: "not_started",
  SEER_CHECK: "seer_check",
  WOLF_ACTION: "wolf_action",
  NIGHT_RESOLUTION: "night_resolution",
  DAY_SPEECH: "day_speech",
  DAY_VOTE: "day_vote",
  VOTE_RESOLUTION: "vote_resolution",
  GAME_OVER: "game_over",
});

export class GameRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

const ROLE_COUNTS = Object.freeze({
  [ROLES.SEER]: 1,
  [ROLES.WEREWOLF]: 2,
  [ROLES.VILLAGER]: 3,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

function campOf(role) {
  return role === ROLES.WEREWOLF ? CAMPS.WEREWOLF : CAMPS.GOOD;
}

function shuffled(values, rng) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(rng() * (index + 1));
    [copy[index], copy[selected]] = [copy[selected], copy[index]];
  }
  return copy;
}

function highestTargets(votes, rng) {
  const counts = new Map();
  for (const targetId of Object.values(votes)) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  const highest = Math.max(...counts.values());
  const tied = [...counts.entries()]
    .filter(([, count]) => count === highest)
    .map(([targetId]) => targetId);
  return {
    counts: Object.fromEntries(counts),
    tied,
    selected: tied[Math.floor(rng() * tied.length)],
  };
}

export class WerewolfEngine {
  static createTeachingGame({ players, humanPlayerId, rng = Math.random, maxDays = 6 }) {
    const human = players.find((player) => player.id === humanPlayerId);
    if (!human) {
      throw new GameRuleError("UNKNOWN_HUMAN", "真人玩家必须存在于玩家列表中");
    }
    const botIds = players.filter((player) => player.id !== humanPlayerId).map((player) => player.id);
    const botRoles = shuffled(
      [ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER],
      rng,
    );
    const roles = { [humanPlayerId]: ROLES.SEER };
    botIds.forEach((id, index) => {
      roles[id] = botRoles[index];
    });
    return new WerewolfEngine({ players, roles, rng, maxDays });
  }

  constructor({ players, roles, rng = Math.random, maxDays = 6 }) {
    this._validateSetup(players, roles, maxDays);
    this._rng = rng;
    this._maxDays = maxDays;
    this._players = players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      controller: player.controller ?? "bot",
      seat: seat + 1,
      role: roles[player.id],
      alive: true,
    }));
    this._state = {
      phase: PHASES.NOT_STARTED,
      night: 0,
      day: 0,
      currentSpeakerId: null,
      seerChecks: {},
      wolfActions: {},
      speeches: {},
      votes: {},
      winner: null,
      resultReason: null,
    };
    this._events = [];
  }

  start() {
    this._requirePhase(PHASES.NOT_STARTED);
    this._state.night = 1;
    this._state.phase = PHASES.SEER_CHECK;
    this._record("GAME_STARTED", { playerCount: this._players.length }, "public");
    for (const player of this._players) {
      this._record(
        "ROLE_ASSIGNED",
        { playerId: player.id, role: player.role },
        { kind: "players", ids: [player.id] },
      );
    }
    return this.getStatus();
  }

  submitSeerCheck(actorId, targetId) {
    this._requirePhase(PHASES.SEER_CHECK);
    const actor = this._requireAlive(actorId);
    const target = this._requireAlive(targetId);
    if (actor.role !== ROLES.SEER) {
      throw new GameRuleError("ROLE_FORBIDDEN", "只有预言家可以查验");
    }
    if (actorId === targetId) {
      throw new GameRuleError("SELF_TARGET", "预言家不能查验自己");
    }
    if (this._state.seerChecks[this._state.night]) {
      throw new GameRuleError("DUPLICATE_ACTION", "本夜已经完成查验");
    }

    const result = campOf(target.role);
    this._state.seerChecks[this._state.night] = { actorId, targetId, result };
    this._record(
      "SEER_CHECKED",
      { actorId, targetId, result },
      { kind: "players", ids: [actorId] },
    );
    this._state.phase = this._state.night === 1
      ? PHASES.NIGHT_RESOLUTION
      : PHASES.WOLF_ACTION;
    return { targetId, result };
  }

  submitWolfAttack(actorId, targetId) {
    this._requirePhase(PHASES.WOLF_ACTION);
    const actor = this._requireAlive(actorId);
    const target = this._requireAlive(targetId);
    if (actor.role !== ROLES.WEREWOLF) {
      throw new GameRuleError("ROLE_FORBIDDEN", "只有存活狼人可以选择袭击目标");
    }
    if (target.role === ROLES.WEREWOLF) {
      throw new GameRuleError("WOLF_TEAM_TARGET", "狼人不能袭击狼队友");
    }
    if (this._state.wolfActions[actorId]) {
      throw new GameRuleError("DUPLICATE_ACTION", "该狼人本夜已经提交行动");
    }

    this._state.wolfActions[actorId] = targetId;
    this._record(
      "WOLF_TARGET_SUBMITTED",
      { actorId, targetId },
      { kind: "role", role: ROLES.WEREWOLF },
    );
    if (Object.keys(this._state.wolfActions).length === this._livingRole(ROLES.WEREWOLF).length) {
      this._state.phase = PHASES.NIGHT_RESOLUTION;
    }
    return { accepted: true };
  }

  resolveNight() {
    this._requirePhase(PHASES.NIGHT_RESOLUTION);
    let eliminatedId = null;
    let selection = null;

    if (this._state.night > 1) {
      selection = highestTargets(this._state.wolfActions, this._rng);
      eliminatedId = selection.selected;
      this._eliminate(eliminatedId, "night_attack");
    }

    this._record(
      "NIGHT_RESOLVED",
      {
        night: this._state.night,
        eliminatedId,
        protectedFirstNight: this._state.night === 1,
      },
      "public",
    );
    this._state.wolfActions = {};

    if (eliminatedId && this._checkWinAfterElimination()) {
      return { eliminatedId, gameOver: true };
    }

    this._state.day += 1;
    this._beginSpeech();
    return { eliminatedId, gameOver: false, selection };
  }

  submitSpeech(actorId, text = "") {
    this._requirePhase(PHASES.DAY_SPEECH);
    const actor = this._requireAlive(actorId);
    if (actorId !== this._state.currentSpeakerId) {
      throw new GameRuleError("NOT_CURRENT_SPEAKER", "尚未轮到该玩家发言");
    }
    if (this._state.speeches[actorId] !== undefined) {
      throw new GameRuleError("DUPLICATE_ACTION", "该玩家本日已经发言");
    }
    if (typeof text !== "string" || text.length > 100) {
      throw new GameRuleError("INVALID_SPEECH", "发言必须是100字以内的文本");
    }

    this._state.speeches[actorId] = text;
    this._record("PLAYER_SPOKE", { actorId, text, skipped: text.length === 0 }, "public");

    const living = this._livingPlayers();
    const currentIndex = living.findIndex((player) => player.id === actor.id);
    const next = living.slice(currentIndex + 1).find(
      (player) => this._state.speeches[player.id] === undefined,
    );
    if (next) {
      this._state.currentSpeakerId = next.id;
    } else {
      this._state.currentSpeakerId = null;
      this._state.phase = PHASES.DAY_VOTE;
    }
    return { accepted: true };
  }

  submitVote(actorId, targetId) {
    this._requirePhase(PHASES.DAY_VOTE);
    this._requireAlive(actorId);
    this._requireAlive(targetId);
    if (actorId === targetId) {
      throw new GameRuleError("SELF_TARGET", "玩家不能投票给自己");
    }
    if (this._state.votes[actorId]) {
      throw new GameRuleError("DUPLICATE_ACTION", "该玩家本日已经投票");
    }

    this._state.votes[actorId] = targetId;
    this._record(
      "VOTE_SUBMITTED",
      { actorId },
      { kind: "players", ids: [actorId] },
    );
    if (Object.keys(this._state.votes).length === this._livingPlayers().length) {
      this._state.phase = PHASES.VOTE_RESOLUTION;
    }
    return { accepted: true };
  }

  resolveVote() {
    this._requirePhase(PHASES.VOTE_RESOLUTION);
    const selection = highestTargets(this._state.votes, this._rng);
    const tied = selection.tied.length > 1;
    const eliminatedId = tied ? null : selection.selected;

    if (eliminatedId) {
      this._eliminate(eliminatedId, "day_vote");
    }
    this._record(
      "VOTE_RESOLVED",
      {
        day: this._state.day,
        ballots: { ...this._state.votes },
        counts: selection.counts,
        tied,
        eliminatedId,
      },
      "public",
    );
    this._state.votes = {};

    if (eliminatedId && this._checkWinAfterElimination()) {
      return { eliminatedId, tied, gameOver: true };
    }
    if (this._state.day >= this._maxDays) {
      this._finish("draw", "day_limit");
      return { eliminatedId, tied, gameOver: true };
    }

    this._beginNight();
    return { eliminatedId, tied, gameOver: false };
  }

  observe(viewerId) {
    const viewer = this._requirePlayer(viewerId);
    const gameOver = this._state.phase === PHASES.GAME_OVER;
    const visibleEvents = this._events
      .filter((event) => gameOver || this._canSee(event.visibility, viewer))
      .map(({ visibility, ...event }) => clone(event));
    const selfChecks = Object.fromEntries(
      Object.entries(this._state.seerChecks)
        .filter(([, check]) => check.actorId === viewerId)
        .map(([night, check]) => [night, clone(check)]),
    );

    return {
      viewer: {
        id: viewer.id,
        role: viewer.role,
        camp: campOf(viewer.role),
        alive: viewer.alive,
      },
      status: this.getStatus(),
      players: this._players.map((player) => ({
        id: player.id,
        name: player.name,
        seat: player.seat,
        alive: player.alive,
        ...(gameOver || player.id === viewerId ? { role: player.role } : {}),
      })),
      wolfTeam: viewer.role === ROLES.WEREWOLF
        ? this._players.filter((player) => player.role === ROLES.WEREWOLF).map((player) => player.id)
        : undefined,
      seerChecks: viewer.role === ROLES.SEER ? selfChecks : undefined,
      action: this._legalActionFor(viewer),
      events: visibleEvents,
    };
  }

  getStatus() {
    return clone({
      phase: this._state.phase,
      night: this._state.night,
      day: this._state.day,
      currentSpeakerId: this._state.currentSpeakerId,
      winner: this._state.winner,
      resultReason: this._state.resultReason,
      maxDays: this._maxDays,
    });
  }

  getReplay() {
    if (this._state.phase !== PHASES.GAME_OVER) {
      throw new GameRuleError("REPLAY_LOCKED", "完整复盘仅在游戏结束后开放");
    }
    return clone({
      result: {
        winner: this._state.winner,
        reason: this._state.resultReason,
        day: this._state.day,
        night: this._state.night,
      },
      roles: Object.fromEntries(this._players.map((player) => [player.id, player.role])),
      survivors: this._livingPlayers().map((player) => player.id),
      events: this._events.map(({ visibility, ...event }) => event),
    });
  }

  _validateSetup(players, roles, maxDays) {
    if (!Array.isArray(players) || players.length !== 6) {
      throw new GameRuleError("INVALID_PLAYER_COUNT", "教学局必须恰好有6名玩家");
    }
    const ids = players.map((player) => player.id);
    if (new Set(ids).size !== players.length || ids.some((id) => !id)) {
      throw new GameRuleError("INVALID_PLAYER_ID", "玩家ID必须存在且互不重复");
    }
    if (players.some((player) => !player.name)) {
      throw new GameRuleError("INVALID_PLAYER_NAME", "每名玩家都需要名称");
    }
    const counts = Object.values(roles ?? {}).reduce((result, role) => {
      result[role] = (result[role] ?? 0) + 1;
      return result;
    }, {});
    if (ids.some((id) => !roles?.[id])
      || Object.entries(ROLE_COUNTS).some(([role, count]) => counts[role] !== count)
      || Object.keys(roles).length !== players.length) {
      throw new GameRuleError("INVALID_ROLE_SET", "身份必须为2狼人、1预言家和3村民");
    }
    if (!Number.isInteger(maxDays) || maxDays < 1) {
      throw new GameRuleError("INVALID_DAY_LIMIT", "最大白天数必须是正整数");
    }
  }

  _record(type, payload, visibility) {
    this._events.push({
      sequence: this._events.length + 1,
      type,
      phase: this._state.phase,
      day: this._state.day,
      night: this._state.night,
      ...clone(payload),
      visibility,
    });
  }

  _canSee(visibility, viewer) {
    if (visibility === "public") return true;
    if (visibility.kind === "players") return visibility.ids.includes(viewer.id);
    if (visibility.kind === "role") return visibility.role === viewer.role;
    return false;
  }

  _requirePhase(expected) {
    if (this._state.phase !== expected) {
      throw new GameRuleError(
        "WRONG_PHASE",
        `当前阶段为 ${this._state.phase}，要求阶段为 ${expected}`,
      );
    }
  }

  _requirePlayer(playerId) {
    const player = this._players.find((candidate) => candidate.id === playerId);
    if (!player) throw new GameRuleError("UNKNOWN_PLAYER", `未知玩家：${playerId}`);
    return player;
  }

  _requireAlive(playerId) {
    const player = this._requirePlayer(playerId);
    if (!player.alive) throw new GameRuleError("PLAYER_DEAD", `玩家 ${playerId} 已出局`);
    return player;
  }

  _livingPlayers() {
    return this._players.filter((player) => player.alive);
  }

  _livingRole(role) {
    return this._players.filter((player) => player.alive && player.role === role);
  }

  _beginSpeech() {
    this._state.speeches = {};
    this._state.phase = PHASES.DAY_SPEECH;
    this._state.currentSpeakerId = this._livingPlayers()[0].id;
    this._record("DAY_STARTED", { day: this._state.day }, "public");
  }

  _beginNight() {
    this._state.night += 1;
    this._state.currentSpeakerId = null;
    this._state.speeches = {};
    this._state.wolfActions = {};
    this._state.phase = this._livingRole(ROLES.SEER).length > 0
      ? PHASES.SEER_CHECK
      : PHASES.WOLF_ACTION;
    this._record("NIGHT_STARTED", { night: this._state.night }, "public");
  }

  _eliminate(playerId, cause) {
    const player = this._requireAlive(playerId);
    player.alive = false;
    this._record("PLAYER_ELIMINATED", { playerId, cause }, "public");
  }

  _checkWinAfterElimination() {
    const wolves = this._livingRole(ROLES.WEREWOLF).length;
    const good = this._livingPlayers().length - wolves;
    if (wolves === 0) {
      this._finish(CAMPS.GOOD, "all_werewolves_eliminated");
      return true;
    }
    if (wolves >= good) {
      this._finish(CAMPS.WEREWOLF, "werewolves_reached_parity");
      return true;
    }
    return false;
  }

  _finish(winner, reason) {
    this._state.winner = winner;
    this._state.resultReason = reason;
    this._state.phase = PHASES.GAME_OVER;
    this._state.currentSpeakerId = null;
    this._record("GAME_ENDED", { winner, reason }, "public");
  }

  _legalActionFor(viewer) {
    if (!viewer.alive || this._state.phase === PHASES.GAME_OVER) return null;
    const otherLiving = this._livingPlayers()
      .filter((player) => player.id !== viewer.id)
      .map((player) => player.id);

    if (this._state.phase === PHASES.SEER_CHECK
      && viewer.role === ROLES.SEER
      && !this._state.seerChecks[this._state.night]) {
      return { type: "seer_check", targets: otherLiving };
    }
    if (this._state.phase === PHASES.WOLF_ACTION
      && viewer.role === ROLES.WEREWOLF
      && !this._state.wolfActions[viewer.id]) {
      return {
        type: "wolf_attack",
        targets: this._livingPlayers()
          .filter((player) => player.role !== ROLES.WEREWOLF)
          .map((player) => player.id),
      };
    }
    if (this._state.phase === PHASES.DAY_SPEECH
      && viewer.id === this._state.currentSpeakerId) {
      return { type: "speech", maxLength: 100 };
    }
    if (this._state.phase === PHASES.DAY_VOTE && !this._state.votes[viewer.id]) {
      return { type: "vote", targets: otherLiving };
    }
    return null;
  }
}
