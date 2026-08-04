import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

function readPort(value) {
  const port = Number.parseInt(value ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

const port = readPort(process.env.PORT);
const host = process.env.HOST?.trim() || "0.0.0.0";
const outDir = path.resolve("dist");
const clientDir = path.resolve(outDir, "client");

const { server } = await startProdServer({ port, host, outDir });
const [vinextHandler] = server.listeners("request");

if (typeof vinextHandler !== "function") {
  throw new Error("Unable to initialize the vinext request handler.");
}

server.removeAllListeners("request");
server.on("request", async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    vinextHandler(request, response);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad Request");
    return;
  }

  if (pathname === "/" || pathname.startsWith("/.vite/")) {
    vinextHandler(request, response);
    return;
  }

  const relativePath = pathname.replace(/^\/+/, "").replaceAll("/", path.sep);
  const filePath = path.resolve(clientDir, relativePath);
  const safePrefix = `${clientDir}${path.sep}`.toLowerCase();

  if (!filePath.toLowerCase().startsWith(safePrefix)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");

    const extension = path.extname(filePath).toLowerCase();
    const cacheControl = pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";

    response.writeHead(200, {
      "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
      "Content-Length": String(fileStat.size),
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
  } catch {
    vinextHandler(request, response);
  }
});
