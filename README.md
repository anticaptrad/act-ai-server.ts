# Anticaptrad AI server

`act-ai-server` is the Anticaptrad Node.js/TypeScript service for paid LLM script generation, the current video-generation placeholder, and guarded YouTube publication. It uses Fastify, exposes public health/readiness probes, and protects every `/api/*` route with a shared server secret.

## Safety boundary

This service can spend provider quota and publish to a real YouTube channel, so network reachability is never authorization. `/api/*` fails closed when `SERVER_AUTH_SECRET` is missing and requires the `x-server-auth` header when it is configured. Provider and YouTube credentials come only from the process environment or the runtime secret manager; do not add `.env` files or `dotenv`.

YouTube uploads are resolved inside `YOUTUBE_UPLOAD_DIR` (default `/mnt/renders`), reject traversal and outward-pointing symlinks, enforce size/format limits, and default to private visibility. Configure `YOUTUBE_CHANNEL_ID` or `YOUTUBE_CHANNEL_HANDLE` in production so the service verifies that its OAuth credentials own the intended channel before the first upload.

## Local development

Requirements: Node.js 22 and npm.

```bash
npm ci
npm run typecheck
npm test
```

Start the service only after supplying the configuration needed for the route you intend to exercise:

```bash
npm run build
SERVER_AUTH_SECRET='local-only-secret' PORT=3000 npm start
```

`GET /health` is a liveness probe. `GET /ready` reports whether server auth, LLM providers, and YouTube publishing are configured without revealing credential values.

## Configuration

Core runtime variables:

- `SERVER_AUTH_SECRET` — required for all `/api/*` calls; absent means protected routes return 503.
- `PORT` — HTTP port, default `3000`.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY` — optional provider credentials, loaded lazily per provider.
- `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `GROK_MODEL`, `XAI_BASE_URL` — optional provider/model overrides.
- `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` — required together for YouTube publication.
- `YOUTUBE_REDIRECT_URI` — OAuth redirect used by the configured client.
- `YOUTUBE_UPLOAD_DIR` — approved render directory.
- `YOUTUBE_MAX_UPLOAD_BYTES` — upload-size ceiling.
- `YOUTUBE_CHANNEL_ID`, `YOUTUBE_CHANNEL_HANDLE` — expected channel identity pins.
- `YOUTUBE_PRIVACY_STATUS` — defaults to `private`; use broader visibility only through reviewed deployment configuration.

Do not put real values in documentation, Git history, issue bodies, command arguments, or telemetry.

## HTTP surface

- `GET /health` — public liveness.
- `GET /ready` — public configuration/readiness summary.
- `POST /api/generate/script` — authenticated paid LLM script generation.
- `POST /api/generate/video` — authenticated placeholder video-generation path.
- `POST /api/publish/youtube` — authenticated, channel-verified YouTube upload from the confined render directory.

## CI and contribution

Pull requests run the repository CI on Ubuntu 24.04 with immutable Action pins, persisted checkout credentials disabled, locked dependency installation, TypeScript type-checking, build, and tests. Read `agents.md` before editing; it defines the repository's credential, channel-ownership, upload-path, publishing, and Git safety invariants.

Security reports should follow `SECURITY.md` and must never include live credentials or refresh tokens.