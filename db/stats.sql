-- Player records for LAN battles. Applied with:
--   wrangler d1 execute arcade-stats --remote --file db/stats.sql

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  -- Lowercased nickname, so "Alpha" and "alpha" cannot both be registered.
  nickname_key TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_player_idx ON sessions(player_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

-- One row per finished LAN game. Abandoned games are never written, so a
-- player cannot dodge a loss by disconnecting.
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  player_a TEXT NOT NULL,
  player_b TEXT NOT NULL,
  score_a INTEGER NOT NULL,
  score_b INTEGER NOT NULL,
  -- Player id of the winner, or NULL for a draw.
  winner TEXT,
  difficulty TEXT NOT NULL,
  moves INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS matches_player_a_idx ON matches(player_a);
CREATE INDEX IF NOT EXISTS matches_player_b_idx ON matches(player_b);
CREATE INDEX IF NOT EXISTS matches_finished_idx ON matches(finished_at);
