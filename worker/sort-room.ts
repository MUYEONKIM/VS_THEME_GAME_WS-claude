/** One Durable Object instance per sorting-battle room code. */
import { DurableObject } from "cloudflare:workers";
import { MEMORY_CARD_IMAGES } from "../app/memory-assets";
import {
  buildSortRound,
  normalizeSortDifficulty,
  normalizeSortDuration,
  SORT_LEAD_IN,
  SORT_PENALTY,
  SORT_SCORE,
  type SortDifficulty,
  type SortRound,
  sideFor,
} from "../app/sort-schedule";
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

type Player = {
  id: string;
  name: string;
  accountId: string | null;
  lastSeen: number;
};

type ChatMessage = {
  id: string;
  playerIndex: 0 | 1;
  name: string;
  text: string;
  image?: string;
  at: number;
};

type Room = {
  code: string;
  durationMs: number;
  difficulty: SortDifficulty;
  players: Player[];
  scores: [number, number];
  /** Both players sort the same queue, each at their own position. */
  progress: [number, number];
  hits: [number, number];
  misses: [number, number];
  round: SortRound | null;
  messages: ChatMessage[];
  startedAt: number | null;
  endsAt: number | null;
  pausedBy: 0 | 1 | null;
  pausedAt: number | null;
  completed: boolean;
  recorded: boolean;
  updatedAt: number;
};

const ROOM_LIFETIME = 2 * 60 * 60 * 1000;
const MAX_MESSAGES = 80;

type Attachment = { playerId: string };

function uploadedImageUrl(key: string) {
  return `/api/memory-images?key=${encodeURIComponent(key)}`;
}

async function imagePool() {
  const uploaded = (await listUploadedImageKeys()).map(uploadedImageUrl);
  return [...MEMORY_CARD_IMAGES, ...uploaded];
}

/**
 * The queue is a few hundred image URLs, so it is sent once when a round is
 * planned rather than with every answer. Clients cache it against `roundKey`.
 */
function publicRoom(room: Room, playerId: string, includeRound: boolean) {
  const playerIndex = room.players.findIndex((player) => player.id === playerId);
  return {
    roundKey: room.startedAt ?? 0,
    round: includeRound ? room.round : null,
    code: room.code,
    durationMs: room.durationMs,
    difficulty: room.difficulty,
    players: room.players.map((player) => ({ name: player.name, guest: player.accountId === null })),
    playerIndex,
    scores: room.scores,
    progress: room.progress,
    hits: room.hits,
    misses: room.misses,
    messages: room.messages,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    pausedBy: room.pausedBy,
    pausedByName: room.pausedBy === null ? "" : (room.players[room.pausedBy]?.name ?? ""),
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

export class SortRoom extends DurableObject {
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
        durationMs: normalizeSortDuration(url.searchParams.get("duration")),
        difficulty: normalizeSortDifficulty(url.searchParams.get("difficulty")),
        players: [],
        scores: [0, 0],
        progress: [0, 0],
        hits: [0, 0],
        misses: [0, 0],
        round: null,
        messages: [],
        startedAt: null,
        endsAt: null,
        pausedBy: null,
        pausedAt: null,
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

    this.broadcast(true);

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
      this.broadcast(true);
      return;
    }

    if (type === "chat") {
      if (room.players.length < 2) {
        sendError(socket, "상대를 기다리는 중입니다.");
        return;
      }
      const text = String(payload.text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 160);
      const image = String(payload.image ?? "");
      if (image && !(await imagePool()).includes(image)) {
        sendError(socket, "보낼 수 없는 사진입니다.");
        return;
      }
      if (!text && !image) return;
      room.messages.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        playerIndex: playerIndex as 0 | 1,
        name: room.players[playerIndex].name,
        text,
        image: image || undefined,
        at: Date.now(),
      });
      if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
      await this.persist();
      this.broadcast();
      return;
    }

    if (type === "pause") {
      if (room.pausedBy === null && room.startedAt !== null && !room.completed) {
        room.pausedBy = playerIndex as 0 | 1;
        room.pausedAt = Date.now();
        await this.persist();
        this.broadcast();
      }
      return;
    }

    if (type === "resume") {
      if (room.pausedBy !== playerIndex || room.pausedAt === null) return;
      const shift = Date.now() - room.pausedAt;
      if (room.startedAt !== null) room.startedAt += shift;
      if (room.endsAt !== null) room.endsAt += shift;
      room.pausedBy = null;
      room.pausedAt = null;
      await this.persist();
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

      room.durationMs = normalizeSortDuration(payload.duration ?? room.durationMs);
      room.difficulty = normalizeSortDifficulty(payload.difficulty ?? room.difficulty);
      room.scores = [0, 0];
      room.progress = [0, 0];
      room.hits = [0, 0];
      room.misses = [0, 0];
      room.pausedBy = null;
      room.pausedAt = null;
      room.completed = false;
      room.recorded = false;
      room.round = buildSortRound(await imagePool(), room.difficulty, room.durationMs);
      room.startedAt = Date.now() + SORT_LEAD_IN;
      room.endsAt = room.startedAt + room.durationMs;
      await this.persist();
      this.broadcast(true);
      return;
    }

    if (type === "answer") {
      if (room.pausedBy !== null || room.completed || room.round === null) return;
      if (room.startedAt === null || Date.now() < room.startedAt) return;
      if (room.endsAt !== null && Date.now() > room.endsAt) return;

      const direction = payload.direction === "left" ? "left" : "right";
      const index = room.progress[playerIndex];
      const image = room.round.queue[index];
      if (!image) return;

      const correct = sideFor(room.round, image) === direction;
      room.scores[playerIndex] = Math.max(0, room.scores[playerIndex] + (correct ? SORT_SCORE : SORT_PENALTY));
      if (correct) room.hits[playerIndex] += 1;
      else room.misses[playerIndex] += 1;
      // The character always leaves the lane, right or wrong.
      room.progress[playerIndex] = index + 1;

      await this.persist();
      this.broadcast();
      await this.settleIfOver();
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

  private async settleIfOver() {
    const room = this.room;
    if (!room || room.completed || room.pausedBy !== null || room.endsAt === null || Date.now() < room.endsAt) {
      return false;
    }

    room.completed = true;
    await this.persist();
    this.broadcast();

    if (!room.recorded && room.players.length === 2 && room.scores[0] !== room.scores[1]) {
      room.recorded = true;
      await this.persist();
      const [first, second] = room.players;
      const winnerIndex = room.scores[0] > room.scores[1] ? 0 : 1;
      await recordMatch({
        game: "sort",
        roomCode: room.code,
        playerA: first.accountId ?? GUEST_ID,
        playerB: second.accountId ?? GUEST_ID,
        scoreA: room.scores[0],
        scoreB: room.scores[1],
        winner: room.players[winnerIndex].accountId ?? GUEST_ID,
        difficulty: `${room.difficulty}/${room.durationMs / 1000}s`,
        moves: room.progress[0] + room.progress[1],
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
    const running = room.endsAt !== null && !room.completed && room.pausedBy === null;
    await this.ctx.storage.setAlarm(running ? (room.endsAt as number) : room.updatedAt + ROOM_LIFETIME);
  }

  private broadcast(includeRound = false) {
    const room = this.room;
    if (!room) return;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      socket.send(JSON.stringify({ type: "state", room: publicRoom(room, attachment?.playerId ?? "", includeRound) }));
    }
  }
}
