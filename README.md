# notify

A small real-time notification system: an **Encore.ts** backend (PostgreSQL via Encore DB) and a **Bun** TypeScript CLI compiled to a single binary. Two channels: `in_app` (delivered synchronously and fanned out over a WebSocket stream) and `email` (queued through an outbox and delivered asynchronously by a cron worker).

## Layout

```
backend/        Encore.ts service "notifications" + migrations
cli/            Bun CLI, compiled to `notify` (single binary)
shared/         @notify/shared — wire types reused by backend, CLI, and tests
tests/          Bun integration tests against a running backend
postman.json    Postman v2.1.0 collection covering every endpoint
```

## Backend — run locally

Prereqs: [Encore CLI](https://encore.dev/docs/install) and Docker (Encore manages Postgres for you).

```powershell
cd backend
bun install
encore run
```

API on `http://127.0.0.1:4000`, dev dashboard on `http://127.0.0.1:9400`. Migrations apply automatically on first run.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/users` | Create user |
| GET | `/users` | List users |
| POST | `/notifications` | Send notification (`userId`, `channel`, `title`, `body`) |
| GET | `/users/:userId/notifications` | List notifications (page/size) |
| GET | `/users/:userId/notifications/unread` | List unread (page/size) |
| POST | `/notifications/:id/read` | Mark read (idempotent) |
| WS | `/users/:userId/notifications/stream` | Live stream + 30s ping; optional `?channel=in_app\|email` filter |

### Email outbox

`POST /notifications` with `channel: "email"` writes the row as `delivery_status = 'pending'`. An Encore `CronJob("email-outbox", every: "1h")` claims pending rows, calls a simulated `deliverEmail()`, and marks them `sent` — or retries with exponential backoff (30s → 2m → 8m → 32m, capped at 2h, max 5 attempts) before marking `failed`. Swap `deliverEmail()` for a real provider (Resend, SES, …) without touching the API surface.

## CLI — build & use

```powershell
cd cli
bun install
bun build --compile ./src/cli.ts --outfile notify
```

On Windows, Bun appends `.exe`, so run as `.\notify.exe`.

Backend URL is `http://127.0.0.1:4000` by default; override with `--api-url=...` or `NOTIFY_API_URL=...`. `--json` on any command prints raw JSON; default output is column-aligned with unread notifications prefixed by `*`.

### Examples

```powershell
.\notify.exe users:create --name="Alice" --email="alice@example.com"
.\notify.exe users:list
.\notify.exe send --user-id=<id> --channel=in_app --title="Hello" --body="Welcome!"
.\notify.exe list   --user-id=<id>
.\notify.exe unread --user-id=<id>
.\notify.exe read   --id=<notification-id>
.\notify.exe subscribe --user-id=<id>     # live WebSocket stream
.\notify.exe                              # interactive REPL (also: notify shell)
```

Inside the REPL, the first Ctrl+C cancels the running command (closing any active WebSocket); a second at an empty prompt exits.

## Architecture & choices

- **One Encore service.** Both `User` and `Notification` live under `notifications/`. A separate `users` service would have added inter-service calls for no real isolation gain at this scale.
- **WebSocket via Encore `streamOut`.** Local fan-out is an in-process `Map<userId, Set<{stream, channel}>>` (`backend/notifications/notification/stream/stream.ts`). The REST `send` handler inserts, then calls `fanOut()` to dispatch to local subscribers. On connect, the stream replays unread rows oldest-first (optionally filtered by `?channel=`) before entering the live loop, so reconnecting clients catch up to current state without a separate REST list call — at-least-once across the connect race, deduped client-side by `notification.id`. Single-process; cross-instance fan-out via an Encore PubSub topic is a documented next step.
- **Email outbox.** `email` notifications never block the request — they're written as `pending`, and a cron worker delivers them with retry + backoff. Decouples "I accepted the notification" from "I delivered it" so a transient provider hiccup doesn't surface to callers.
- **Shared workspace package** (`shared/`). Wire types live in `@notify/shared`, resolved via `tsconfig` `paths` — no build step. Backend, CLI, and tests all import from the same source, so a wire change breaks compilation everywhere it matters.
- **Hand-rolled CLI arg parser.** No Commander/Yargs — supports `--name=value`, `--name value`, short aliases (`-h`, `-v`), and a quote-aware tokenizer for the interactive shell.
- **Tooling.** TypeScript 5.5, ESLint 9 (flat config) + `typescript-eslint` recommended, Prettier 3 — both packages, same scripts (`lint`, `lint:fix`, `format`, `format:check`).

## Tests

```powershell
bun tests/integration_test.ts   # REST endpoints + error paths + pagination
bun tests/ws_smoke.ts            # WebSocket fan-out, isolation, ordering, backlog replay
```

Both create fresh per-run data and are safe to re-run against a live backend (`NOTIFY_API_URL` overrides the default).

A Postman collection (`postman.json`) at the repo root covers every endpoint and auto-captures the created `userId` / `notificationId` between requests.

## If I had more time

- **Auth.** Endpoints are currently open. Encore's `auth` handler + a per-user opaque token issued at create time (hashed in the DB) and verified as `Authorization: Bearer …` would be the natural next step. The CLI would read it from `NOTIFY_TOKEN` or `--token`.
- **Cursor-based replay on reconnect.** Unread rows replay on connect, but a client that read a notification and then disconnected won't see anything new that arrived while it was away unless it's still unread. A `?since=<notificationId>` query param would let clients resume exactly where they left off.
- **Deploy to Encore Cloud.** A live URL the reviewer can `curl` is more impressive than `git clone && encore run`. `encore app create && encore app link && git push encore main` is ~30 minutes including the first cold-start.
- **CI workflow.** A simple `.github/workflows/ci.yml` running typecheck + lint + format:check on both packages (+ spawning the backend and running the integration tests) is a high-leverage add.
- **Real email provider.** `deliverEmail()` in `outbox.ts` is the seam — swap the simulated log line for `resend.emails.send(...)` (or SES `SendEmailCommand`) and the outbox + retry machinery wraps the real call untouched.
- **Idempotency-Key header** on `POST /notifications` — store `key → notificationId` for ~24h and replay on duplicate. Prevents accidental double-sends from client retries.

## AI assistance

Claude (Anthropic) was used as a pair-programmer throughout: scaffolding the Encore service and migrations, writing the WebSocket stream and fan-out map, designing the CLI's REPL + abort-signal handling, and splitting types/classes into their own files. All code was read, understood, and adjusted by hand before commit.
