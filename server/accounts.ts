import { getRuntimeBindings } from "./runtime-bindings";
import { GUEST_ID } from "./stats";

export const CODE_LENGTH = 4;
export const NICKNAME_MAX = 18;

const SESSION_DAYS = 30;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

export type Player = {
  id: string;
  nickname: string;
};

export type AuthResult =
  | { ok: true; token: string; player: Player; created: boolean }
  | { ok: false; status: number; error: string };

type PlayerRow = {
  id: string;
  nickname: string;
  code_hash: string;
  salt: string;
  failed_attempts: number;
  locked_until: number;
};

async function database() {
  const { STATS } = await getRuntimeBindings();
  return STATS ?? null;
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A salted single-pass digest. Deliberately not a slow KDF: a 4-digit code has
 * only 10,000 possibilities, so key stretching buys little, and the Workers
 * free plan caps CPU per request. The lockout below is the real defence — this
 * only keeps codes out of plain sight in the database.
 */
async function hashCode(code: string, salt: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${code}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export function normalizeNickname(value: unknown) {
  return String(value ?? "").trim().slice(0, NICKNAME_MAX);
}

export function normalizeCode(value: unknown) {
  return String(value ?? "").trim();
}

export function validateCredentials(nickname: string, code: string) {
  if (!nickname) return "닉네임을 입력해주세요.";
  // Reserved: head-to-head records show unsigned-in opponents under this name.
  if (nickname.toLowerCase() === GUEST_ID) return "'guest'는 사용할 수 없는 닉네임입니다.";
  if (!/^\d{4}$/.test(code)) return `비밀번호는 숫자 ${CODE_LENGTH}자리입니다.`;
  return "";
}

async function issueSession(db: D1Database, playerId: string) {
  const token = `${randomHex(16)}${randomHex(16)}`;
  const now = Date.now();
  await db
    .prepare("INSERT INTO sessions (token, player_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(token, playerId, now, now + SESSION_DAYS * 24 * 60 * 60 * 1000)
    .run();
  return token;
}

/** Logs in an existing nickname, or registers it on first use. */
export async function loginOrRegister(nickname: string, code: string): Promise<AuthResult> {
  const db = await database();
  if (!db) return { ok: false, status: 503, error: "기록 저장소를 사용할 수 없습니다." };

  const problem = validateCredentials(nickname, code);
  if (problem) return { ok: false, status: 400, error: problem };

  const key = nickname.toLowerCase();
  const now = Date.now();
  const existing = await db
    .prepare("SELECT id, nickname, code_hash, salt, failed_attempts, locked_until FROM players WHERE nickname_key = ?1")
    .bind(key)
    .first<PlayerRow>();

  if (!existing) {
    const salt = randomHex(8);
    const player: Player = { id: crypto.randomUUID(), nickname };
    await db
      .prepare(`
        INSERT INTO players (id, nickname, nickname_key, code_hash, salt, failed_attempts, locked_until, created_at, last_seen_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?6)
      `)
      .bind(player.id, player.nickname, key, await hashCode(code, salt), salt, now)
      .run();
    return { ok: true, token: await issueSession(db, player.id), player, created: true };
  }

  if (existing.locked_until > now) {
    const seconds = Math.ceil((existing.locked_until - now) / 1000);
    return { ok: false, status: 429, error: `비밀번호를 여러 번 틀렸습니다. ${seconds}초 뒤에 다시 시도해주세요.` };
  }

  if (!timingSafeEqual(await hashCode(code, existing.salt), existing.code_hash)) {
    const attempts = existing.failed_attempts + 1;
    const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_MS : 0;
    await db
      .prepare("UPDATE players SET failed_attempts = ?2, locked_until = ?3 WHERE id = ?1")
      .bind(existing.id, lockedUntil ? 0 : attempts, lockedUntil)
      .run();
    return {
      ok: false,
      status: 401,
      error: lockedUntil
        ? "비밀번호를 5번 틀렸습니다. 60초 뒤에 다시 시도해주세요."
        : "비밀번호가 올바르지 않습니다.",
    };
  }

  await db
    .prepare("UPDATE players SET failed_attempts = 0, locked_until = 0, nickname = ?2, last_seen_at = ?3 WHERE id = ?1")
    .bind(existing.id, nickname, now)
    .run();

  return { ok: true, token: await issueSession(db, existing.id), player: { id: existing.id, nickname }, created: false };
}

export async function playerForToken(token: string): Promise<Player | null> {
  if (!token) return null;
  const db = await database();
  if (!db) return null;

  const row = await db
    .prepare(`
      SELECT players.id AS id, players.nickname AS nickname
      FROM sessions JOIN players ON players.id = sessions.player_id
      WHERE sessions.token = ?1 AND sessions.expires_at > ?2
    `)
    .bind(token, Date.now())
    .first<Player>();

  return row ?? null;
}

export async function signOut(token: string) {
  const db = await database();
  if (!db || !token) return;
  await db.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run();
}
