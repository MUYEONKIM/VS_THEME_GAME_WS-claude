import { getRuntimeBindings } from "./runtime-bindings";

export type PlayerRecord = {
  games: number;
  wins: number;
  losses: number;
};

export type RankingRow = PlayerRecord & {
  id: string;
  nickname: string;
  rank: number;
};

export type OpponentRow = PlayerRecord & {
  id: string;
  nickname: string;
  lastPlayedAt: number;
};

export type FinishedMatch = {
  /** Which of the two head-to-head games produced this result. */
  game?: "memory" | "reaction" | "sort";
  roomCode: string;
  playerA: string;
  playerB: string;
  scoreA: number;
  scoreB: number;
  winner: string | null;
  difficulty: string;
  moves: number;
};

/**
 * Stand-in id for a player who chose to play without signing in. It is stored
 * in `matches` but never in `players`, so guests keep no record of their own
 * and cannot appear in the ranking, while a signed-in opponent still gets the
 * win or loss counted and sees "Guest" in their head-to-head list.
 */
export const GUEST_ID = "guest";
export const GUEST_NICKNAME = "Guest";

// Counted from the players' perspective: every recorded row has a winner, so a
// game is either a win or a loss.
const RECORD_COLUMNS = `
  COUNT(matches.id) AS games,
  SUM(CASE WHEN matches.winner = players.id THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN matches.winner <> players.id THEN 1 ELSE 0 END) AS losses
`;

async function database() {
  const { STATS } = await getRuntimeBindings();
  return STATS ?? null;
}

const emptyRecord: PlayerRecord = { games: 0, wins: 0, losses: 0 };

export async function recordMatch(match: FinishedMatch) {
  const db = await database();
  if (!db) return;
  // Nobody to credit when neither seat is signed in.
  if (match.playerA === GUEST_ID && match.playerB === GUEST_ID) return;
  // There are no draws in the records: a tied game simply is not written.
  if (!match.winner) return;
  await db
    .prepare(`
      INSERT INTO matches (id, game, room_code, player_a, player_b, score_a, score_b, winner, difficulty, moves, finished_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `)
    .bind(
      crypto.randomUUID(),
      match.game ?? "memory",
      match.roomCode,
      match.playerA,
      match.playerB,
      match.scoreA,
      match.scoreB,
      match.winner,
      match.difficulty,
      match.moves,
      Date.now(),
    )
    .run();
}

export async function recordFor(playerId: string): Promise<PlayerRecord> {
  const db = await database();
  if (!db) return emptyRecord;
  const row = await db
    .prepare(`
      SELECT ${RECORD_COLUMNS}
      FROM players
      LEFT JOIN matches ON matches.player_a = players.id OR matches.player_b = players.id
      WHERE players.id = ?1
    `)
    .bind(playerId)
    .first<PlayerRecord>();
  return row ?? emptyRecord;
}

/** Ranked purely on total wins; fewer games breaks a tie, then nickname. */
export async function ranking(limit = 20): Promise<RankingRow[]> {
  const db = await database();
  if (!db) return [];
  const { results } = await db
    .prepare(`
      SELECT players.id AS id, players.nickname AS nickname, ${RECORD_COLUMNS}
      FROM players
      JOIN matches ON matches.player_a = players.id OR matches.player_b = players.id
      GROUP BY players.id
      ORDER BY wins DESC, games ASC, players.nickname ASC
      LIMIT ?1
    `)
    .bind(limit)
    .all<Omit<RankingRow, "rank">>();
  return results.map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function opponentsFor(playerId: string): Promise<OpponentRow[]> {
  const db = await database();
  if (!db) return [];
  const { results } = await db
    .prepare(`
      WITH head_to_head AS (
        SELECT
          CASE WHEN matches.player_a = ?1 THEN matches.player_b ELSE matches.player_a END AS opponent_id,
          COUNT(*) AS games,
          SUM(CASE WHEN matches.winner = ?1 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN matches.winner <> ?1 THEN 1 ELSE 0 END) AS losses,
          MAX(matches.finished_at) AS last_played_at
        FROM matches
        WHERE matches.player_a = ?1 OR matches.player_b = ?1
        GROUP BY opponent_id
      )
      SELECT head_to_head.opponent_id AS id,
             COALESCE(players.nickname, ?2) AS nickname,
             head_to_head.games AS games, head_to_head.wins AS wins,
             head_to_head.losses AS losses,
             head_to_head.last_played_at AS lastPlayedAt
      FROM head_to_head
      LEFT JOIN players ON players.id = head_to_head.opponent_id
      ORDER BY games DESC, lastPlayedAt DESC
    `)
    .bind(playerId, GUEST_NICKNAME)
    .all<OpponentRow>();
  return results;
}
