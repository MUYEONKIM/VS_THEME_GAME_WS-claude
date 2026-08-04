# Covert Code Arcade

A web game disguised as a VS Code window. The editor pane runs a photo matching
game, the terminal pane runs 2048, Snake and Pong, and two players can face off
in real time over a shared room code.

Built on [vinext](https://github.com/cloudflare/vinext) (Next.js App Router
running on Cloudflare Workers), with Durable Objects for live match state,
Workers KV for uploaded photos and D1 for player records.

## Features

- **VS Code disguise** — file explorer, tabs, breadcrumbs, status bar, real
  Codicon font, and code that types itself out
- **Terminal games** — 2048, Snake, Pong
- **Photo matching** — Easy 5×4, Normal 6×5, Hard 8×6, with combo scoring
- **Head-to-head play** — create a room, share the four-character code, and both
  boards stay in sync over a WebSocket
- **Live chat** — text plus sending any card photo into the conversation
- **Photo management** — upload and delete card photos from inside the game,
  guarded by a password
- **Accounts and ranking** — sign in with a nickname and a 4-digit code to have
  wins, losses and head-to-head totals recorded, or play as a guest

## Requirements

- Node.js `>=22.13.0`
- A Cloudflare account (free plan is enough) if you want to deploy

## Running it locally

```bash
npm install
cp .env.example .env
npm run dev
```

Then open <http://localhost:3010>. In the file explorer, expand **games** and
click the top entry to launch the matching game.

`npm run dev` runs the app inside `workerd` through the Cloudflare Vite plugin,
so Durable Objects, KV and D1 all work locally against simulated storage — no
Cloudflare account needed just to play.

To let another device on your network join a match, bind to all interfaces:

```bash
HOST=0.0.0.0 npm run dev
```

> `npm start` serves a plain Node build without the Cloudflare runtime, so LAN
> matches are unavailable there. Use `npm run dev` for two-player play.

## Using your own photos

The repository ships 24 generated sample cards in `public/assets`. To play with
your own pictures without committing them:

1. Drop image files into `public/assets/`
2. Create `app/photos.local.json` listing their paths:
   ```json
   ["/assets/my-photo-1.jpg", "/assets/my-photo-2.jpg"]
   ```

Both are git-ignored. When `app/photos.local.json` exists its list replaces the
samples; otherwise the samples are used, so a fresh clone always works. Hard
mode needs at least 24 images.

You can also add photos at runtime with the in-game **Add photos** button, which
stores them in KV instead — those work without a redeploy.

## Deploying to Cloudflare

Create the resources once:

```bash
npx wrangler login
npx wrangler kv namespace create MEMORY_IMAGES
npx wrangler d1 create arcade-stats
```

Put the returned ids into `.env` (see `.env.example` for the variable names),
then apply the database schema and deploy:

```bash
npx wrangler d1 execute arcade-stats --remote --file db/stats.sql
npm run deploy
```

Finally set the photo upload password as a secret:

```bash
npx wrangler secret put UPLOAD_PASSWORD --name <your-worker-name>
```

The site is then live at `https://<WORKER_NAME>.<your-subdomain>.workers.dev`.

## How it works

| Concern | Where it lives |
| --- | --- |
| Live match state, turns, chat | Durable Object `MemoryRoom`, one instance per room code |
| Uploaded photos | Workers KV, with a single index key instead of list scans |
| Accounts, finished matches, ranking | D1 (`players`, `sessions`, `matches`) |
| Bundled sample cards | Static assets, served free and unmetered |

Players talk to their room over a WebSocket rather than polling, so an idle room
costs nothing and moves show up on the other board immediately. Mismatched cards
are flipped back by a Durable Object alarm, so the timing does not depend on
either client staying connected.

Only games played to completion are recorded — quitting partway never writes a
result, so a loss cannot be dodged by disconnecting. Guests keep no record of
their own, but a signed-in opponent still gets the win or loss counted and sees
the match listed against "Guest".

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Local dev server with the Cloudflare runtime |
| `npm run build` | Production build into `dist/` |
| `npm start` | Serve the build with plain Node (no LAN play) |
| `npm run deploy` | Build and deploy to Cloudflare Workers |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Typecheck plus build |
| `npm run lint` | ESLint |

## Layout

```
app/            UI, game logic and API routes
worker/         Worker entry point and the MemoryRoom Durable Object
server/         Accounts, stats queries and storage adapters
db/stats.sql    D1 schema
public/assets/  Card images (samples committed, private photos ignored)
```

## License

No license is granted for reuse. The code is published for reference.
