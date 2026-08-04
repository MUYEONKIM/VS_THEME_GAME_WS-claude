import samplePhotos from "./photos.json";

export type Difficulty = "easy" | "normal" | "hard";

export const MEMORY_DIFFICULTIES: Record<Difficulty, { label: string; columns: number; rows: number; pairs: number }> = {
  easy: { label: "Easy", columns: 5, rows: 4, pairs: 10 },
  normal: { label: "Normal", columns: 6, rows: 5, pairs: 15 },
  hard: { label: "Hard", columns: 8, rows: 6, pairs: 24 },
};

/**
 * `photos.local.json` is git-ignored: it lists private photos that sit in
 * `public/assets` on the deploying machine and are never committed. Vite's
 * glob resolves to nothing when the file is absent, so a fresh clone falls
 * back to the bundled sample cards and still builds and plays.
 */
const localModules = import.meta.glob<string[]>("./photos.local.json", { eager: true, import: "default" });
const localPhotos = Object.values(localModules)[0] ?? [];

export const MEMORY_CARD_IMAGES: readonly string[] =
  localPhotos.length > 0 ? localPhotos : (samplePhotos as string[]);
