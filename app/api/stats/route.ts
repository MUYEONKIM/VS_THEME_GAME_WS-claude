import { playerForToken } from "../../../server/accounts";
import { opponentsFor, ranking, recordFor } from "../../../server/stats";

const RANKING_LIMIT = 20;

export async function GET(request: Request) {
  const token = request.headers.get("x-session-token") ?? new URL(request.url).searchParams.get("token") ?? "";
  const player = await playerForToken(token);

  // The ranking is public; the personal sections only appear when signed in.
  const [board, record, opponents] = await Promise.all([
    ranking(RANKING_LIMIT),
    player ? recordFor(player.id) : Promise.resolve(null),
    player ? opponentsFor(player.id) : Promise.resolve([]),
  ]);

  return Response.json(
    { player, record, ranking: board, opponents },
    { headers: { "Cache-Control": "no-store" } },
  );
}
