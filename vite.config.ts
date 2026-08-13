import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import { sites } from "./build/sites-vite-plugin";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// Placeholders keep a fresh clone building. Real ids belong in `.env`, which is
// git-ignored — see `.env.example`.
const PLACEHOLDER_KV_ID = "0".repeat(32);
const PLACEHOLDER_D1_ID = "00000000-0000-4000-8000-000000000000";

function bindingConfig(env: Record<string, string>) {
  return {
    // Becomes the first label of the workers.dev URL, so it is set here rather
    // than inherited from the npm package name.
    name: env.WORKER_NAME || "covert-code-arcade",
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    // Uploaded photos live in Workers KV rather than R2 because KV needs no
    // separate product activation or billing profile on the free plan.
    kv_namespaces: [{ binding: "MEMORY_IMAGES", id: env.MEMORY_IMAGES_KV_ID || PLACEHOLDER_KV_ID }],
    // Player accounts and finished-match history. Rankings need ordering and
    // joins, which is the one thing KV and Durable Object storage cannot do.
    d1_databases: [
      {
        binding: "STATS",
        database_name: env.STATS_D1_NAME || "arcade-stats",
        database_id: env.STATS_D1_ID || PLACEHOLDER_D1_ID,
      },
    ],
    // LAN rooms live in a Durable Object so both players share one authoritative
    // copy of the board over a WebSocket instead of polling a database.
    durable_objects: {
      bindings: [
        { name: "MEMORY_ROOM", class_name: "MemoryRoom" },
        { name: "REACTION_ROOM", class_name: "ReactionRoom" },
      ],
    },
    // SQLite-backed classes are the ones available on the Workers free plan.
    migrations: [
      { tag: "v1", new_sqlite_classes: ["MemoryRoom"] },
      { tag: "v2", new_sqlite_classes: ["ReactionRoom"] },
    ],
  };
}

export default defineConfig(async ({ mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Empty prefix so plain names like WORKER_NAME are picked up; nothing here is
  // exposed to the browser bundle.
  const env = loadEnv(mode, process.cwd(), "");

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: bindingConfig(env),
      }),
    ],
  };
});
