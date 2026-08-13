/**
 * Shared rules for the reaction battle. The Durable Object uses this to plan a
 * head-to-head round and the browser uses the very same code for solo practice,
 * so practising can never drift from the real thing.
 */

export type ReactionTargetKind = "normal" | "golden" | "trap";

export type ReactionTarget = {
  id: string;
  image: string;
  kind: ReactionTargetKind;
  /** Percentages of the play area, so every screen places them identically. */
  x: number;
  y: number;
  showAt: number;
  hideAt: number;
};

export const REACTION_DURATIONS = [10_000, 30_000, 60_000] as const;
export type ReactionDuration = (typeof REACTION_DURATIONS)[number];

/** How long each kind stays clickable. */
export const TARGET_LIFETIME: Record<ReactionTargetKind, number> = {
  normal: 1150,
  golden: 950,
  trap: 1350,
};

export const TARGET_SCORE: Record<ReactionTargetKind, number> = {
  normal: 1,
  golden: 2,
  trap: -1,
};

/** Clicking empty space costs a point. */
export const MISS_PENALTY = -1;
/** Late clicks are still honoured this long after a target hides. */
export const HIT_GRACE = 260;
/** Pause between the Start press and the first circle, for the countdown. */
export const LEAD_IN = 3_000;

const FIRST_SPAWN = 400;
/** Tighter than a circle's lifetime, so several are on screen at once. */
const MIN_GAP = 230;
const GAP_SPREAD = 330;
const TAIL_MARGIN = 900;
const MIN_SEPARATION = 17;

export function normalizeReactionDuration(value: unknown): ReactionDuration {
  const candidate = Number(value);
  return (REACTION_DURATIONS as readonly number[]).includes(candidate)
    ? (candidate as ReactionDuration)
    : 30_000;
}

function rollKind(): ReactionTargetKind {
  const roll = Math.random();
  if (roll < 0.08) return "golden";
  if (roll < 0.2) return "trap";
  return "normal";
}

/**
 * Plans the whole round up front. In a head-to-head match this is sent once so
 * that playing costs a message per click instead of a server tick per circle.
 */
export function buildReactionSchedule(startAt: number, durationMs: number, images: readonly string[]) {
  const targets: ReactionTarget[] = [];
  let offset = FIRST_SPAWN;

  while (offset < durationMs - TAIL_MARGIN) {
    const kind = rollKind();
    const showAt = startAt + offset;
    // Several circles overlap in time, so keep clear of every one that is
    // still on screen rather than just the previous.
    const concurrent = targets.filter((candidate) => candidate.hideAt > showAt);
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      x = 8 + Math.random() * 84;
      y = 10 + Math.random() * 78;
      if (concurrent.every((other) => Math.hypot(other.x - x, other.y - y) > MIN_SEPARATION)) break;
    }

    targets.push({
      id: `${targets.length.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      image: images[Math.floor(Math.random() * images.length)] ?? "",
      kind,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      showAt,
      hideAt: showAt + TARGET_LIFETIME[kind],
    });

    offset += MIN_GAP + Math.random() * GAP_SPREAD;
  }

  return targets;
}
