import { deleteUploadedImage, getUploadPassword, listUploadedImageKeys, MEMORY_UPLOAD_PREFIX, readUploadedImage, writeUploadedImage } from "../../../server/memory-image-store";
import { MEMORY_CARD_IMAGES } from "../../memory-assets";

const MAX_FILES_PER_UPLOAD = 10;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_UPLOADED_IMAGES = 200;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function uploadedImageUrl(key: string) {
  return `/api/memory-images?key=${encodeURIComponent(key)}`;
}

function extensionFor(type: string) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "gif";
}

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (key) {
    if (!key.startsWith(MEMORY_UPLOAD_PREFIX) || key.includes("..")) return new Response("Not found", { status: 404 });
    const object = await readUploadedImage(key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers({ "Content-Type": object.contentType });
    if (object.etag) headers.set("ETag", object.etag);
    headers.set("Cache-Control", "public, max-age=86400, immutable");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(object.body, { headers });
  }

  const uploadedKeys = await listUploadedImageKeys();
  return json({
    images: [...MEMORY_CARD_IMAGES, ...uploadedKeys.map(uploadedImageUrl)],
    builtInCount: MEMORY_CARD_IMAGES.length,
    uploadedCount: uploadedKeys.length,
    uploadEnabled: Boolean(await getUploadPassword()),
  });
}

// Only uploaded photos can be removed; the built-in ones ship as static assets.
export async function DELETE(request: Request) {
  const uploadPassword = await getUploadPassword();
  if (!uploadPassword) return json({ error: "Photo uploads have not been configured." }, 503);
  if (request.headers.get("x-upload-password") !== uploadPassword) return json({ error: "비밀번호가 올바르지 않습니다." }, 401);

  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!key.startsWith(MEMORY_UPLOAD_PREFIX) || key.includes("..")) return json({ error: "기본 사진은 삭제할 수 없습니다." }, 400);

  await deleteUploadedImage(key);
  const remaining = await listUploadedImageKeys();
  return json({
    deleted: key,
    images: [...MEMORY_CARD_IMAGES, ...remaining.map(uploadedImageUrl)],
    builtInCount: MEMORY_CARD_IMAGES.length,
    uploadedCount: remaining.length,
  });
}

export async function POST(request: Request) {
  const uploadPassword = await getUploadPassword();
  if (!uploadPassword) return json({ error: "Photo uploads have not been configured." }, 503);
  if (request.headers.get("x-upload-password") !== uploadPassword) return json({ error: "비밀번호가 올바르지 않습니다." }, 401);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "업로드 데이터를 읽을 수 없습니다." }, 400);
  }

  const files = form.getAll("images").filter((value): value is File => value instanceof File && value.size > 0);
  if (files.length === 0) return json({ error: "추가할 사진을 선택해주세요." }, 400);
  if (files.length > MAX_FILES_PER_UPLOAD) return json({ error: `한 번에 최대 ${MAX_FILES_PER_UPLOAD}장까지 추가할 수 있습니다.` }, 400);

  for (const file of files) {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) return json({ error: `${file.name}: JPG, PNG, WEBP, GIF 형식만 가능합니다.` }, 400);
    if (file.size > MAX_FILE_SIZE) return json({ error: `${file.name}: 사진 한 장은 5MB 이하여야 합니다.` }, 400);
  }

  const existingKeys = await listUploadedImageKeys();
  if (existingKeys.length + files.length > MAX_UPLOADED_IMAGES) {
    return json({ error: `업로드 사진은 최대 ${MAX_UPLOADED_IMAGES}장까지 보관할 수 있습니다.` }, 409);
  }

  const uploaded: string[] = [];
  for (const file of files) {
    const key = `${MEMORY_UPLOAD_PREFIX}${crypto.randomUUID()}.${extensionFor(file.type)}`;
    await writeUploadedImage(key, await file.arrayBuffer(), file.type, file.name);
    uploaded.push(uploadedImageUrl(key));
  }

  return json({
    added: uploaded.length,
    uploaded,
    images: [...MEMORY_CARD_IMAGES, ...existingKeys.map(uploadedImageUrl), ...uploaded],
  });
}
