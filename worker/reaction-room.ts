/** One Durable Object instance per reaction-battle room code. */
import { DurableObject } from "cloudflare:workers";
import { MEMORY_CARD_IMAGES } from "../app/memory-assets";
import { listUploadedImageKeys } from "../server/memory-image-store";
import { playerForToken } from "../server/accounts";
import { GUEST_ID, recordMatch } from "../server/stats";
import {
  CLOSE_BAD_REQUEST,
  CLOSE_NOT_A_PLAYER,
  CLOSE_ROOM_EXPIRED,
  CLOSE_ROOM_FULL,
  CLOSE_ROOM_MISSING,
  rejectSocket,
} from "./memory-room";

export const REACTION_DURATIONS = [10_000, 30_000, 60_000] as const;
export type ReactionDuration = (typeof REACTION_DURATIONS)[number];

type TargetKind = "normal" | "golden" | "trap";

type Target = {
  id: string;
  image: string;
  kind: TargetKind;
  /** Percentages of the play area, so both clients place them identically. */
  x: number;
  y: number;
  showAt: number;
  hideAt: number;
};

type Player = {
  id: string;
  name: string;
  accountId: string | null;
  lastSeen: number;
  /** Guards against a client spamming empty-space clicks. */
  lastMissAt?: number;
};

type Room = {
  code: string;
  durationMs: number;
  players: Player[];
  scores: [number, number];
  targets: Target[];
  /** Target id -> seat that claimed it first. */
  taken: Record<string, 0 | 1>;
  startedAt: number | null;
  endsAt: number | null;
  completed: boolean;
  recorded: boolean;
  updatedAt: number;
};

const ROOM_LIFETIME = 2 * 60 * 60 * 1000;
const LEAD_IN = 3_000;
const FIRST_SPAWN = 500;
const MIN_GAP = 420;
const GAP_SPREAD = 620;
const TAIL_MARGIN = 900;
/** How long each kind stays clickable. */
const LIFETIME: Record<TargetKind, number> = { normal: 1150, golden: 950, trap: 1350 };
/** Late clicks are still honoured this long after a target hides. */
const GRACE = 260;
const SCORE: Record<TargetKind, number> = { normal: 1, golden: 2, trap: -1 };
/** Clicking empty space costs a point. */
const MISS_PENALTY = -1;
const MISS_COOLDOWN = 120;

type Attachment = { playerId: string };

function normalizeDuration(value: unknown): ReactionDuration {
  const candidate = Number(value);
  return (REACTION_DURATIONS as readonly number[]).includes(candidate)
    ? (candidate as ReactionDuration)
    : 30_000;
}

function uploadedImageUrl(key: string) {
  return `/api/memory-images?key=${encodeURIComponent(key)}`;
}

async function imagePool() {
  const uploaded = (await listUploadedImageKeys()).map(uploadedImageUrl);
  return [...MEMORY_CARD_IMAGES, ...uploaded];
}

function rollKind(): TargetKind {
  const roll = Math.random();
  if (roll < 0.08) return "golden";
  if (roll < 0.2) return "trap";
  return "normal";
}

/**
 * The whole round is planned when it starts and sent once, so playing only
 * costs a message per click instead of a server tick per circle.
 */
async function buildSchedule(startAt: number, durationMs: number) {
  const images = await imagePool();
  const targets: Target[] = [];
  let offset = FIRST_SPAWN;

  while (offset < durationMs - TAIL_MARGIN) {
    const kind = rollKind();
    const previous = targets[targets.length - 1];
    let x = 0;
    let y = 0;
    // A couple of tries is enough to stop circles landing on top of each other.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      x = 8 + Math.random() * 84;
      y = 10 + Math.random() * 78;
      if (!previous || Math.hypot(previous.x - x, previous.y - y) > 22) break;
    }

    targets.push({
      id: `${targets.length.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      image: images[Math.floor(Math.random() * images.length)] ?? "",
      kind,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      showAt: startAt + offset,
      hideAt: startAt + offset + LIFETIME[kind],
    });

    offset += MIN_GAP + Math.random() * GAP_SPREAD;
  }

  return targets;
}

function publicRoom(room: Room, playerId: string) {
  const playerIndex = room.players.findIndex((player) => player.id === playerId);
  return {
    code: room.code,
    durationMs: room.durationMs,
    players: room.players.map((player) => ({ name: player.name, guest: player.accountId === null })),
    playerIndex,
    scores: room.scores,
    targets: room.targets,
    taken: room.taken,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    running: room.startedAt !== null && !room.completed,
    completed: room.completed,
    waiting: room.players.length < 2,
    isHost: playerIndex === 0,
    serverNow: Date.now(),
  };
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function sendError(socket: WebSocket, message: string) {
  socket.send(JSON.stringify({ type: "error", message }));
}

export class ReactionRoom extends DurableObject {
  private room: Room | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<Room>("room")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/reserve") {
      if (this.room) return json({ error: "Room code is taken." }, 409);
      const code = (url.searchParams.get("code") ?? "").toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) return json({ error: "Invalid room code." }, 400);
      this.room = {
        code,
        durationMs: normalizeDuration(url.searchParams.get("duration")),
        players: [],
        scores: [0, 0],
        targets: [],
        taken: {},
        startedAt: null,
        endsAt: null,
        completed: false,
        recorded: false,
        updatedAt: Date.now(),
      };
      await this.persist();
      return json({ code });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "Expected a WebSocket upgrade." }, 426);
    }

    const room = this.room;
    if (!room) return rejectSocket(CLOSE_ROOM_MISSING, "Room not found.");

    const playerId = (url.searchParams.get("playerId") ?? "").slice(0, 80);
    if (!playerId) return rejectSocket(CLOSE_BAD_REQUEST, "Player identity is missing.");

    const account = await playerForToken(url.searchParams.get("token") ?? "");
    const playerName = account
      ? account.nickname
      : (url.searchParams.get("name") ?? "Guest").trim().slice(0, 18) || "Guest";

    const existing = room.players.find((player) => player.id === playerId);
    if (!existing && room.players.length >= 2) return rejectSocket(CLOSE_ROOM_FULL, "Room is full.");
    if (existing) {
      existing.name = playerName;
      existing.accountId = account?.id ?? null;
      existing.lastSeen = Date.now();
    } else {
      room.players.push({ id: playerId, name: playerName, accountId: account?.id ?? null, lastSeen: Date.now() });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ playerId } satisfies Attachment);

    await this.persist();
    this.broadcast();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const room = this.room;
    if (!room) {
      socket.close(CLOSE_ROOM_MISSING, "Room not found.");
      return;
    }

    const attachment = socket.deserializeAttachment() as Attachment | null;
    const playerIndex = room.players.findIndex((player) => player.id === attachment?.playerId);
    if (playerIndex < 0) {
      socket.close(CLOSE_NOT_A_PLAYER, "Join the room first.");
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      sendError(socket, "Invalid request.");
      return;
    }

    const type = String(payload.type ?? "");
    room.players[playerIndex].lastSeen = Date.now();

    if (type === "state") {
      await this.settleIfOver();
      this.broadcast();
      return;
    }

    if (type === "start") {
      if (playerIndex !== 0) {
        sendError(socket, "방장만 시작할 수 있습니다.");
        return;
      }
      if (room.players.length < 2) {
        sendError(socket, "상대를 기다리는 중입니다.");
        return;
      }
      if (room.startedAt !== null && !room.completed) return;

      room.durationMs = normalizeDuration(payload.duration ?? room.durationMs);
      room.scores = [0, 0];
      room.taken = {};
      room.completed = false;
      room.recorded = false;
      // The lead-in gives both screens time to show a countdown.
      room.startedAt = Date.now() + LEAD_IN;
      room.endsAt = room.startedAt + room.durationMs;
      room.targets = await buildSchedule(room.startedAt, room.durationMs);
      await this.persist();
      this.broadcast();
      return;
    }

    if (type === "hit") {
      if (room.startedAt === null || room.completed) return;
      const targetId = String(payload.id ?? "");
      const target = room.targets.find((candidate) => candidate.id === targetId);
      if (!target) return;
      // First click wins: whoever the object sees first takes it.
      if (room.taken[targetId] !== undefined) return;

      const now = Date.now();
      if (now < target.showAt - GRACE || now > target.hideAt + GRACE) return;

      room.taken[targetId] = playerIndex as 0 | 1;
      // Scores never drop below zero, so a bad run cannot bury a player.
      room.scores[playerIndex] = Math.max(0, room.scores[playerIndex] + SCORE[target.kind]);
      await this.persist();
      this.broadcast();
      await this.settleIfOver();
      return;
    }

    if (type === "miss") {
      if (room.startedAt === null || room.completed || Date.now() < room.startedAt) return;
      const player = room.players[playerIndex];
      const now = Date.now();
      if (player.lastMissAt && now - player.lastMissAt < MISS_COOLDOWN) return;
      player.lastMissAt = now;
      room.scores[playerIndex] = Math.max(0, room.scores[playerIndex] + MISS_PENALTY);
      await this.persist();
      this.broadcast();
      return;
    }

    sendError(socket, "Unknown action.");
  }

  async alarm() {
    const room = this.room;
    if (!room) return;

    if (await this.settleIfOver()) return;

    if (Date.now() - room.updatedAt >= ROOM_LIFETIME) {
      for (const socket of this.ctx.getWebSockets()) socket.close(CLOSE_ROOM_EXPIRED, "Room expired.");
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.scheduleAlarm();
  }

  /** Ends the round once the clock runs out, and writes the result once. */
  private async settleIfOver() {
    const room = this.room;
    if (!room || room.completed || room.endsAt === null || Date.now() < room.endsAt) return false;

    room.completed = true;
    await this.persist();
    this.broadcast();

    if (!room.recorded && room.players.length === 2 && room.scores[0] !== room.scores[1]) {
      room.recorded = true;
      await this.persist();
      const [first, second] = room.players;
      const winnerIndex = room.scores[0] > room.scores[1] ? 0 : 1;
      await recordMatch({
        game: "reaction",
        roomCode: room.code,
        playerA: first.accountId ?? GUEST_ID,
        playerB: second.accountId ?? GUEST_ID,
        scoreA: room.scores[0],
        scoreB: room.scores[1],
        winner: room.players[winnerIndex].accountId ?? GUEST_ID,
        difficulty: `${room.durationMs / 1000}s`,
        moves: Object.keys(room.taken).length,
      });
    }
    return true;
  }

  private async persist() {
    const room = this.room;
    if (!room) return;
    room.updatedAt = Date.now();
    await this.ctx.storage.put("room", room);
    await this.scheduleAlarm();
  }

  private async scheduleAlarm() {
    const room = this.room;
    if (!room) return;
    // One alarm for the whole round: either the finish line or the cleanup.
    const next = room.endsAt !== null && !room.completed ? room.endsAt : room.updatedAt + ROOM_LIFETIME;
    await this.ctx.storage.setAlarm(next);
  }

  private broadcast() {
    const room = this.room;
    if (!room) return;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      socket.send(JSON.stringify({ type: "state", room: publicRoom(room, attachment?.playerId ?? "") }));
    }
  }
}
