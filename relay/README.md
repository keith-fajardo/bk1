# bk1 playroom relay (Cloudflare Worker)

Hosts the WebSocket signaling + message relay for the bk1 playroom feature.
Same wire protocol as `src/playroom/relay-server.ts` (the local Bun variant),
so the bk1 client doesn't know or care which backend it's talking to.

## Why Cloudflare Workers

The Bun relay at `src/playroom/relay-server.ts` listens on `ws://localhost:8787`
and only works for clients on the same machine. For real cross-machine play
(your friend on their laptop, you on yours), the relay needs to be reachable
on the open internet. Cloudflare Workers give us:

- A stable HTTPS URL with WebSocket support
- Free tier (100k requests/day) — plenty for casual use
- No server to maintain
- A Durable Object for the rooms map so state survives between requests

## Deploy (one-time, ~5 minutes)

```sh
cd relay
npm install
npx wrangler login        # opens browser; sign in to Cloudflare (free account)
npx wrangler deploy
```

Wrangler will print the deployed URL — something like
`https://bk1-playroom-relay.<your-subdomain>.workers.dev`. The WebSocket
endpoint is the same URL with `wss://` instead of `https://`.

## Point bk1 at the deployed relay

Set the env var when launching bk1:

```sh
PLAYROOM_RELAY_URL=wss://bk1-playroom-relay.<your-subdomain>.workers.dev bun run dev
```

Or export it in your shell rc:

```sh
export PLAYROOM_RELAY_URL=wss://bk1-playroom-relay.<your-subdomain>.workers.dev
```

## Local development against the Worker (instead of `bun run relay`)

```sh
cd relay
npx wrangler dev          # serves the worker at http://localhost:8787
```

Then in another terminal, `PLAYROOM_RELAY_URL=ws://localhost:8787 bun run dev`
(or just `bun run dev` — that's the default).

## Costs

The free tier covers 100k requests/day and 10 GB-seconds of Durable Object
compute. A typical jakenpoy match is ~30 WebSocket messages = ~30 requests.
You'd need ~3000 matches/day to even approach the free limit.

## Architecture notes

- **One Durable Object instance** (id `"global"`) holds all rooms in memory.
  Easy to reason about, scales to thousands of concurrent rooms before any
  single-instance bottleneck. If you ever need more, switch to per-pin DOs:
  `env.ROOMS.idFromName(pin)` inside `worker.ts`'s default fetch.
- **No persistent storage.** Rooms live only while their players are
  connected. If the DO is evicted while a match is in flight, both sides
  will get a `peer_left` event from their socket close and the room ends
  cleanly — same behavior as a real disconnect.
- **The protocol code is duplicated** between this worker and
  `src/playroom/relay-protocol.ts`. They must stay in sync. The worker
  bundle can't import from the bk1 source tree because Cloudflare ships
  only what's inside `relay/`. If we ever build a shared types package,
  both should consume that.
