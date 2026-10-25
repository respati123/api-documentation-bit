# API Documentation Desktop and Cloud

Electron desktop API client and browser portal built with React, TypeScript, and Vite. The desktop app edits local collections and syncs commits to the Cloud API; the browser portal reads shared API contracts and manages workspace access.

## Project layout

- `src/main/` contains Electron main-process IPC, HTTP requests, SQLite workspace storage, and encrypted session storage.
- `src/preload/` exposes the restricted desktop API to the renderer.
- `src/renderer/` contains the React UI, styles, and tree merge logic.
- `src/cloud/` contains the browser Cloud workspace portal.
- `src/mcp/` contains the local stdio MCP server used by AI clients.
- `server/` contains the Bun/PostgreSQL API, schema, and merge tests.

## Development

Install dependencies with `npm install`. For local cloud collaboration, copy `.env.example` to `.env` and start PostgreSQL, the API, Mailpit, and the Cloud web portal together:

```bash
cp .env.example .env
docker compose up --build -d
npm run dev
```

Open the Cloud portal at `http://localhost:3000`, the API health check at `http://localhost:3001/health`, and the Mailpit inbox at `http://localhost:8026`. Compose publishes only Mailpit's inbox UI; the API sends mail to `mailpit:1025` over the private Compose network. Compose keeps PostgreSQL data in the `apidocs-postgres` named volume and binds services to localhost. Invitations opened from email go to the browser portal. If a local port is occupied, change `POSTGRES_PORT`, `API_PORT`, or `CLOUD_WEB_PORT` in `.env`. The Cloud portal uses the same origin for API requests through its Nginx proxy. To run the API outside Docker, start PostgreSQL with `docker compose up -d postgres`, copy `server/.env.example` to `server/.env`, and configure an SMTP service reachable from the host; then run `npm run api:dev` and `npm run cloud:dev`, and open `http://localhost:5174`. Set `PUBLIC_WEB_URL=http://localhost:5174` in `server/.env` for browser invitations during this mode. Set root `VITE_API_URL` for the desktop app's API endpoint. Local workspaces still work without the API. On Linux, dev and preview pass Electron's `--no-sandbox` flag to accommodate systems without a configured SUID Chromium helper.

## Build and validation

- `npm run typecheck` checks Electron and renderer TypeScript.
- `npm run api:typecheck` checks server TypeScript.
- `npm run cloud:typecheck` checks Cloud portal TypeScript.
- `npm run cloud:dev` runs the browser portal on port `5174` and proxies API calls to port `3001`.
- `npm run cloud:build` creates the static portal bundle in `dist-cloud/`.
- `npm run api:test` runs the tree merge tests with Bun.
- `npm run build` creates Electron production bundles and builds the MCP server.
- `npm run mcp:typecheck` checks the local MCP server.
- `npm run build:mcp` builds the MCP server to `out/mcp/server.js`.
- `npm run mcp:local` starts the MCP server over stdio for a configured AI client.

The Bun API requires `DATABASE_URL`; its schema is initialized on startup. The Compose password is for local development only. Configure production database credentials and `PORT` through the deployment environment. Never commit `.env` files, credentials, or invite tokens.

## Collaboration behavior

Account sessions are encrypted with Electron `safeStorage` when the operating system provides it. Cloud workspaces support owner, editor, and viewer roles. Owners can send one-use email invitations; they expire after seven days and must be accepted by an account with the invited email address. For local development, inspect messages in Mailpit at `http://localhost:8026`. Accounts do not yet verify mailbox ownership, so configure a verification flow before relying on email identity in production. The Changes dialog shows untracked, modified, and deleted items, supports stage/unstage, and commits only staged snapshots. Push sends local commits; pull fast-forwards when possible and otherwise merges separate items, prompting for a local or cloud choice when the same item conflicts. Connected team members receive a WebSocket notification when a push advances a workspace; the app marks cloud updates as available, and each member pulls manually. A 30-second cloud-head poll remains as a fallback. Live editing and branches are not supported yet.

## Request workflow

Request Docs and structured response contracts are stored in workspace snapshots and sync with cloud commits. Define response status codes, descriptions, content types, JSON Schemas, and example payloads in the **Responses** tab. **Read docs** opens a read-only API reference for the selected endpoint; the collection remains its navigation. The OpenAPI 3.0/3.1 JSON or YAML importer reads response descriptions, schemas, and examples, and the exporter includes them with referenced component schemas. Use **OpenAPI** in the workspace sidebar to import (imports append requests) or export the current workspace.

## Local MCP for AI agents

The local MCP server reads the same SQLite database as the desktop app and exposes workspace, collection, request, preview, and apply tools. Open the desktop app once to create its local database, then run `npm run build:mcp`. For Codex, register the built server with `codex mcp add api-documentation -- node /absolute/path/to/api-documentation-bit/out/mcp/server.js`; restart Codex and use `/mcp` or `codex mcp list` to confirm the connection. Other MCP clients can launch the same `node out/mcp/server.js` command over stdio. Keep the desktop app open to see applied edits immediately; edits stay local drafts until a teammate commits and pushes them. On Linux, the default database directory is `~/.config/api-documentation-bit`; on macOS it is `~/Library/Application Support/api-documentation-bit`; on Windows it is `%APPDATA%\api-documentation-bit`. Set `API_DOCS_USER_DATA_DIR` in the MCP client when the app uses a custom data directory.

Read and search tools redact authentication credentials, sensitive headers and parameters, secret-like JSON fields, and local file paths. Write changes with `preview_changes`, show that preview to the user, then call `apply_changes`. Deleting an item also requires explicit user approval and `confirmDelete: true`. Deprecation status is saved with the request and included in OpenAPI import/export.

