/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { CLOSE_BAD_REQUEST, CLOSE_NO_CAPACITY, MemoryRoom, rejectSocket } from "./memory-room";

interface Env {
  ASSETS: Fetcher;
  MEMORY_IMAGES: KVNamespace;
  MEMORY_ROOM: DurableObjectNamespace;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Ambiguous glyphs are left out so a room code can be read aloud.
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_ATTEMPTS = 8;

function randomRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

function roomStub(env: Env, code: string) {
  return env.MEMORY_ROOM.get(env.MEMORY_ROOM.idFromName(code));
}

/** Upgrades a LAN player onto the Durable Object that owns their room code. */
async function routeMemoryRoom(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return Response.json({ error: "Expected a WebSocket upgrade." }, { status: 426 });
  }

  let code = (url.searchParams.get("code") ?? "").trim().toUpperCase();

  if (code === "NEW") {
    const difficulty = url.searchParams.get("difficulty") ?? "easy";
    code = "";
    for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS && !code; attempt += 1) {
      const candidate = randomRoomCode();
      const reserveUrl = new URL("https://memory-room/reserve");
      reserveUrl.searchParams.set("code", candidate);
      reserveUrl.searchParams.set("difficulty", difficulty);
      const reserved = await roomStub(env, candidate).fetch(reserveUrl, { method: "POST" });
      if (reserved.ok) code = candidate;
    }
    if (!code) return rejectSocket(CLOSE_NO_CAPACITY, "Unable to allocate a room code.");
  } else if (!/^[A-Z0-9]{4}$/.test(code)) {
    return rejectSocket(CLOSE_BAD_REQUEST, "Invalid room code.");
  }

  const target = new URL(url);
  target.searchParams.set("code", code);
  return roomStub(env, code).fetch(new Request(target, request));
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/memory/ws") {
      return routeMemoryRoom(request, url, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export { MemoryRoom };
export default worker;
