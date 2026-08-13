/** One Durable Object instance per LAN room code. */
import { DurableObject } from "cloudflare:workers";
import { MEMORY_CARD_IMAGES, MEMORY_DIFFICULTIES, type Difficulty } from "../app/memory-assets";
import { listUploadedImageKeys } from "../server/memory-image-store";
import { playerForToken } from "../server/accounts";
import { GUEST_ID, recordMatch } from "../server/stats";

type Player = {
  id: string;
  name: string;
  // Signed-in account id, or null when the seat is playing as a guest.
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
  difficulty: Difficulty;
  deck: string[];
  openCards: number[];
  matchedCards: number[];
  matchedBy: Array<0 | 1 | null>;
  players: Player[];
  messages: ChatMessage[];
  currentTurn: 0 | 1;
  scores: [number, number];
  combos: [number, number];
  moves: number;
  locked: boolean;
  resolveAt: number | null;
  completed: boolean;
  // Seat that hit Esc to step away, or null while play is running.
  pausedBy: 0 | 1 | null;
  // Set once the finished game has been written to the stats database.
  recorded: boolean;
  updatedAt: number;
};

type Attachment = { playerId: string };

const ROOM_LIFETIME = 2 * 60 * 60 * 1000;
const MISMATCH_DELAY = 850;
const MAX_MESSAGES = 80;

// WebSocket close codes above 4000 are application defined.
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_NOT_A_PLAYER = 4403;
export const CLOSE_ROOM_MISSING = 4404;
export const CLOSE_ROOM_EXPIRED = 4408;
export const CLOSE_ROOM_FULL = 4409;
export const CLOSE_NO_CAPACITY = 4503;

/**
 * Completing the handshake before closing is what lets the browser read the
 * reason; a plain error response would only ever surface as code 1006.
 */
export function rejectSocket(code: number, reason: string) {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function normalizeDifficulty(value: unknown): Difficulty {
  const candidate = String(value ?? "");
  return candidate in MEMORY_DIFFICULTIES ? (candidate as Difficulty) : "easy";
}

function uploadedImageUrl(key: string) {
  return `/api/memory-images?key=${encodeURIComponent(key)}`;
}

async function imagePool() {
  const uploaded = (await listUploadedImageKeys()).map(uploadedImageUrl);
  return [...MEMORY_CARD_IMAGES, ...uploaded];
}

async function shuffleDeck(difficulty: Difficulty) {
  const images = await imagePool();
  for (let index = images.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [images[index], images[swapIndex]] = [images[swapIndex], images[index]];
  }
  const deck = images.slice(0, MEMORY_DIFFICULTIES[difficulty].pairs).flatMap((image) => [image, image]);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function publicRoom(room: Room, playerId: string) {
  const playerIndex = room.players.findIndex((player) => player.id === playerId);
  return {
    code: room.code,
    difficulty: room.difficulty,
    deck: room.deck,
    openCards: room.openCards,
    matchedCards: room.matchedCards,
    matchedBy: room.matchedBy,
    players: room.players.map((player) => ({ name: player.name, guest: player.accountId === null })),
    messages: room.messages,
    playerIndex,
    currentTurn: room.currentTurn,
    scores: room.scores,
    combos: room.combos,
    moves: room.moves,
    locked: room.locked,
    completed: room.completed,
    pausedBy: room.pausedBy,
    pausedByName: room.pausedBy === null ? "" : (room.players[room.pausedBy]?.name ?? ""),
    waiting: room.players.length < 2,
    isHost: playerIndex === 0,
  };
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function sendError(socket: WebSocket, message: string) {
  socket.send(JSON.stringify({ type: "error", message }));
}

export class MemoryRoom extends DurableObject {
  private room: Room | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<Room>("room")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // The Worker reserves a code before handing the host its socket, so an
    // already-initialized object means the generated code collided.
    if (url.pathname === "/reserve") {
      if (this.room) return json({ error: "Room code is taken." }, 409);
      const code = (url.searchParams.get("code") ?? "").toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) return json({ error: "Invalid room code." }, 400);
      const difficulty = normalizeDifficulty(url.searchParams.get("difficulty"));
      this.room = {
        code,
        difficulty,
        deck: [],
        openCards: [],
        matchedCards: [],
        matchedBy: [],
        players: [],
        messages: [],
        currentTurn: 0,
        scores: [0, 0],
        combos: [0, 0],
        moves: 0,
        locked: false,
        resolveAt: null,
        completed: false,
        pausedBy: null,
        recorded: false,
        updatedAt: Date.now(),
      };
      await this.resetRoom(difficulty);
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

    // A valid session decides the display name, so a seat cannot claim someone
    // else's nickname. Without one the seat plays as a guest.
    const account = await playerForToken(url.searchParams.get("token") ?? "");
    const playerName = account
      ? account.nickname
      : (url.searchParams.get("name") ?? "Guest").trim().slice(0, 18) || "Guest";

    // Reconnecting players keep their seat; only genuinely new ids fill a slot.
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

    // An alarm normally settles the mismatch delay, but a message can still
    // arrive first if the object was hibernating.
    const settled = this.settlePendingTurn();
    const type = String(payload.type ?? "");
    room.players[playerIndex].lastSeen = Date.now();

    if (type === "state") {
      await this.commit(settled);
      return;
    }

    if (type === "chat") {
      if (room.players.length < 2) {
        sendError(socket, "Waiting for an opponent.");
        return;
      }
      const text = String(payload.text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 160);
      // Only photos this game already serves may be shared, so a crafted
      // message cannot make the opponent's browser load an arbitrary URL.
      const image = String(payload.image ?? "");
      if (image && !(await imagePool()).includes(image)) {
        sendError(socket, "보낼 수 없는 사진입니다.");
        return;
      }
      if (!text && !image) {
        await this.commit(settled);
        return;
      }
      room.messages.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        playerIndex: playerIndex as 0 | 1,
        name: room.players[playerIndex].name,
        text,
        image: image || undefined,
        at: Date.now(),
      });
      if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
      await this.commit(true);
      return;
    }

    // Esc pauses for both sides; only the player who stepped away resumes.
    if (type === "pause") {
      if (room.pausedBy === null) room.pausedBy = playerIndex as 0 | 1;
      await this.commit(true);
      return;
    }

    if (type === "resume") {
      if (room.pausedBy === playerIndex) room.pausedBy = null;
      await this.commit(true);
      return;
    }

    if (type === "restart") {
      if (playerIndex !== 0) {
        sendError(socket, "Only the host can restart the match.");
        return;
      }
      await this.resetRoom(normalizeDifficulty(payload.difficulty));
      await this.commit(true);
      return;
    }

    if (type === "flip") {
      const cardIndex = Number(payload.cardIndex);
      if (room.players.length < 2) {
        sendError(socket, "Waiting for an opponent.");
        return;
      }
      if (room.pausedBy !== null) {
        sendError(socket, "일시중지 중입니다.");
        return;
      }
      if (room.completed || room.locked || room.currentTurn !== playerIndex) {
        await this.commit(settled);
        return;
      }
      if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= room.deck.length) {
        sendError(socket, "Invalid card.");
        return;
      }
      if (room.openCards.includes(cardIndex) || room.matchedCards.includes(cardIndex)) {
        await this.commit(settled);
        return;
      }

      if (room.openCards.length === 0) {
        room.openCards = [cardIndex];
        await this.commit(true);
        return;
      }

      const firstIndex = room.openCards[0];
      room.openCards = [firstIndex, cardIndex];
      room.moves += 1;
      room.locked = true;

      if (room.deck[firstIndex] === room.deck[cardIndex]) {
        room.matchedCards.push(firstIndex, cardIndex);
        room.matchedBy[firstIndex] = playerIndex as 0 | 1;
        room.matchedBy[cardIndex] = playerIndex as 0 | 1;
        room.scores[playerIndex] += 2 ** room.combos[playerIndex];
        room.combos[playerIndex] += 1;
        room.openCards = [];
        room.locked = false;
        room.resolveAt = null;
        room.completed = room.matchedCards.length === room.deck.length;
      } else {
        room.combos[playerIndex] = 0;
        room.resolveAt = Date.now() + MISMATCH_DELAY;
      }

      await this.commit(true);
      await this.recordIfFinished();
      return;
    }

    sendError(socket, "Unknown action.");
  }

  async alarm() {
    const room = this.room;
    if (!room) return;

    if (this.settlePendingTurn()) {
      await this.commit(true);
      return;
    }

    if (Date.now() - room.updatedAt >= ROOM_LIFETIME) {
      for (const socket of this.ctx.getWebSockets()) socket.close(CLOSE_ROOM_EXPIRED, "Room expired.");
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.scheduleAlarm();
  }

  private settlePendingTurn() {
    const room = this.room;
    if (!room || room.resolveAt === null || Date.now() < room.resolveAt) return false;
    room.openCards = [];
    room.locked = false;
    room.resolveAt = null;
    room.currentTurn = room.currentTurn === 0 ? 1 : 0;
    return true;
  }

  private async resetRoom(difficulty: Difficulty) {
    const room = this.room;
    if (!room) return;
    room.difficulty = difficulty;
    room.deck = await shuffleDeck(difficulty);
    room.openCards = [];
    room.matchedCards = [];
    room.matchedBy = Array.from({ length: room.deck.length }, () => null);
    room.currentTurn = 0;
    room.scores = [0, 0];
    room.combos = [0, 0];
    room.moves = 0;
    room.locked = false;
    room.resolveAt = null;
    room.completed = false;
    room.pausedBy = null;
    room.recorded = false;
  }

  /**
   * Writes the finished game to the stats database exactly once. Games that
   * are abandoned partway are never recorded, so a player cannot dodge a loss
   * by disconnecting.
   */
  private async recordIfFinished() {
    const room = this.room;
    if (!room || !room.completed || room.recorded || room.players.length < 2) return;

    room.recorded = true;
    await this.persist();

    const [first, second] = room.players;
    // A tie has no winner, and records hold no draws, so nothing is written.
    const winnerIndex = room.scores[0] === room.scores[1] ? null : (room.scores[0] > room.scores[1] ? 0 : 1);
    if (winnerIndex === null) return;
    await recordMatch({
      roomCode: room.code,
      playerA: first.accountId ?? GUEST_ID,
      playerB: second.accountId ?? GUEST_ID,
      scoreA: room.scores[0],
      scoreB: room.scores[1],
      winner: winnerIndex === null ? null : (room.players[winnerIndex].accountId ?? GUEST_ID),
      difficulty: room.difficulty,
      moves: room.moves,
    });
  }

  /** Persist only when the room actually changed, then push the new state out. */
  private async commit(changed: boolean) {
    if (changed) await this.persist();
    this.broadcast();
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
    await this.ctx.storage.setAlarm(room.resolveAt ?? room.updatedAt + ROOM_LIFETIME);
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
