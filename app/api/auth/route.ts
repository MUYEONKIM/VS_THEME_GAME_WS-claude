import { loginOrRegister, normalizeCode, normalizeNickname, playerForToken, signOut } from "../../../server/accounts";
import { recordFor } from "../../../server/stats";

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function tokenFrom(request: Request) {
  return request.headers.get("x-session-token") ?? new URL(request.url).searchParams.get("token") ?? "";
}

/** Returns the signed-in player for a stored token, so a reload stays logged in. */
export async function GET(request: Request) {
  const player = await playerForToken(tokenFrom(request));
  if (!player) return json({ player: null });
  return json({ player, record: await recordFor(player.id) });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청을 읽을 수 없습니다." }, 400);
  }

  const result = await loginOrRegister(normalizeNickname(body.nickname), normalizeCode(body.code));
  if (!result.ok) return json({ error: result.error }, result.status);

  return json({
    token: result.token,
    player: result.player,
    created: result.created,
    record: await recordFor(result.player.id),
  });
}

export async function DELETE(request: Request) {
  await signOut(tokenFrom(request));
  return json({ ok: true });
}
