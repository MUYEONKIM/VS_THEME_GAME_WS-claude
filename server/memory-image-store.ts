import { getRuntimeBindings } from "./runtime-bindings";

export const MEMORY_UPLOAD_PREFIX = "memory/";

// KV's free plan allows far more reads than list operations, so the set of
// uploaded keys is tracked in one index entry instead of being listed.
const INDEX_KEY = "memory-index";
const MAX_UPLOADED_IMAGES = 200;

type StoredImage = {
  body: BodyInit;
  contentType: string;
  etag?: string;
};

type ImageMetadata = {
  contentType?: string;
  originalName?: string;
};

function localContentType(key: string) {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function localStorage() {
  const fsModuleName = "node:fs/promises";
  const pathModuleName = "node:path";
  const fs = await import(/* @vite-ignore */ fsModuleName);
  const path = await import(/* @vite-ignore */ pathModuleName);
  const directory = path.join(process.cwd(), ".data", "memory-images");
  await fs.mkdir(directory, { recursive: true });
  return { fs, path, directory };
}

function safeLocalName(key: string) {
  if (!key.startsWith(MEMORY_UPLOAD_PREFIX) || key.includes("..")) return null;
  const name = key.slice(MEMORY_UPLOAD_PREFIX.length);
  return /^[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif)$/.test(name) ? name : null;
}

export async function listUploadedImageKeys(): Promise<string[]> {
  const { MEMORY_IMAGES: store } = await getRuntimeBindings();
  if (store) {
    const keys = await store.get<string[]>(INDEX_KEY, "json");
    return Array.isArray(keys) ? keys.slice(0, MAX_UPLOADED_IMAGES) : [];
  }

  const { fs, directory } = await localStorage();
  const names = await fs.readdir(directory);
  return names
    .filter((name: string) => /^[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif)$/.test(name))
    .slice(0, MAX_UPLOADED_IMAGES)
    .map((name: string) => `${MEMORY_UPLOAD_PREFIX}${name}`);
}

export async function readUploadedImage(key: string): Promise<StoredImage | null> {
  const { MEMORY_IMAGES: store } = await getRuntimeBindings();
  if (store) {
    const { value, metadata } = await store.getWithMetadata<ImageMetadata>(key, "arrayBuffer");
    if (!value) return null;
    return { body: value, contentType: metadata?.contentType || localContentType(key) };
  }

  const name = safeLocalName(key);
  if (!name) return null;
  const { fs, path, directory } = await localStorage();
  try {
    const body = await fs.readFile(path.join(directory, name));
    return { body, contentType: localContentType(key) };
  } catch {
    return null;
  }
}

export async function writeUploadedImage(key: string, data: ArrayBuffer, contentType: string, originalName: string) {
  const { MEMORY_IMAGES: store } = await getRuntimeBindings();
  if (store) {
    await store.put(key, data, {
      metadata: { contentType, originalName: originalName.slice(0, 120) },
    });
    const keys = await listUploadedImageKeys();
    if (!keys.includes(key)) await store.put(INDEX_KEY, JSON.stringify([...keys, key]));
    return;
  }

  const name = safeLocalName(key);
  if (!name) throw new Error("Invalid image key.");
  const { fs, path, directory } = await localStorage();
  await fs.writeFile(path.join(directory, name), new Uint8Array(data));
}

export async function deleteUploadedImage(key: string) {
  const { MEMORY_IMAGES: store } = await getRuntimeBindings();
  if (store) {
    await store.delete(key);
    const keys = await listUploadedImageKeys();
    await store.put(INDEX_KEY, JSON.stringify(keys.filter((entry) => entry !== key)));
    return;
  }

  const name = safeLocalName(key);
  if (!name) throw new Error("Invalid image key.");
  const { fs, path, directory } = await localStorage();
  await fs.rm(path.join(directory, name), { force: true });
}

export async function getUploadPassword() {
  return (await getRuntimeBindings()).UPLOAD_PASSWORD || "";
}
