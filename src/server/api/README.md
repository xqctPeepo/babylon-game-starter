# `api` service

**Runtime:** Node  
**Route prefix:** `/api` (from [src/deployment/settings/settings.mjs](../../deployment/settings/settings.mjs))

This folder is **generated or refreshed** by `npm run deploy:prepare` when the deployment settings list a Node service named `api`.

## Code

[src/server/api/index.ts](index.ts) exports **`healthcheck()`**, returning `{ ok: true, service: 'api' }`. Wire it to your HTTP framework (Express, Fastify, etc.) as needed after scaffolding—for example a `GET /api/health` route that calls `healthcheck()`.

Re-run **`npm run deploy:prepare`** after changing service names or runtimes so folders and stubs stay aligned with settings.
