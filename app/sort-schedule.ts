/**
 * Shared rules for the left/right sorting game. The Durable Object uses this to
 * plan a head-to-head round and the browser uses the same code for practice, so
 * practising can never drift from the real thing.
 */

export type SortDifficulty = "easy" | "normal" | "hard";

export const SORT_DIFFICULTIES: Record<SortDifficulty, { label: string; types: number }> = {
  // How many distinct characters have to be told apart.
  easy: { label: "Easy", types: 2 },
  normal: { label: "Normal", types: 4 },
  hard: { label: "Hard", types: 6 },
};

export const SORT_DURATIONS = [30_000, 60_000, 90_000] as const;
export type SortDuration = (typeof SORT_DURATIONS)[number];

export const SORT_SCORE = 1;
export const SORT_PENALTY = -1;
/** Pause between the Start press and the first character, for the countdown. */
export const SORT_LEAD_IN = 3_000;

export type SortRound = {
  /** Characters that belong on the left, in legend order. */
  left: string[];
  right: string[];
  /** The characters to sort, front of the queue first. */
  queue: string[];
};

export function normalizeSortDifficulty(value: unknown): SortDifficulty {
  const candidate = String(value ?? "");
  return candidate in SORT_DIFFICULTIES ? (candidate as SortDifficulty) : "easy";
}

export function normalizeSortDuration(value: unknown): SortDuration {
  const candidate = Number(value);
  return (SORT_DURATIONS as readonly number[]).includes(candidate) ? (candidate as SortDuration) : 30_000;
}

/** Long enough that a fast player never reaches the end of the round. */
export function queueLengthFor(durationMs: number) {
  return Math.ceil(durationMs / 300) + 40;
}

function shuffled<T>(items: readonly T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function buildSortRound(
  images: readonly string[],
  difficulty: SortDifficulty,
  durationMs: number,
): SortRound {
  const wanted = SORT_DIFFICULTIES[difficulty].types;
  const pool = shuffled(images.filter(Boolean));

  // Repeat the pool if the photo library is smaller than the difficulty asks
  // for, so the game still works on a fresh clone with few sample cards.
  const cast: string[] = [];
  for (let index = 0; index < wanted; index += 1) {
    cast.push(pool[index % Math.max(1, pool.length)] ?? "");
  }

  const half = Math.ceil(wanted / 2);
  const left = cast.slice(0, half);
  const right = cast.slice(half);

  const queue: string[] = [];
  const length = queueLengthFor(durationMs);
  let previous = "";
  for (let index = 0; index < length; index += 1) {
    let pick = cast[Math.floor(Math.random() * cast.length)];
    // Avoid long identical runs, which make the round feel like button mashing.
    if (pick === previous && cast.length > 1) {
      pick = cast[Math.floor(Math.random() * cast.length)];
    }
    previous = pick;
    queue.push(pick);
  }

  return { left, right, queue };
}

/**
 * Reads the queue as an endless ring. A fast player can otherwise burn through
 * the whole planned round and be left with nothing to sort, so the sequence
 * simply wraps — with only two to six characters in play the repeat is
 * invisible.
 */
export function queueAt(round: SortRound, index: number) {
  if (round.queue.length === 0) return "";
  return round.queue[index % round.queue.length];
}

export function sideFor(round: SortRound, image: string): "left" | "right" | null {
  if (round.left.includes(image)) return "left";
  if (round.right.includes(image)) return "right";
  return null;
}
