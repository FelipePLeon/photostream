# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # production (requer env vars setadas no ambiente)
npm run dev      # development: carrega .env automaticamente + auto-restart
```

No build step, no test suite — static files are served directly from `public/`.

Credenciais ficam em `.env` (não commitado). Copie `.env` manualmente ou configure as variáveis no painel do Render para produção.

## Architecture

Single-server Node.js app (Express + Cloudinary). No framework on the frontend — plain HTML/CSS/JS.

**`server.js`** — all backend logic:
- Token-based auth with in-memory sessions (`Map`, 24 h TTL). Token sent as `x-auth-token` header.
- `PUBLIC_VIEW_TOKEN` (env var, default `"photostream"`) allows unauthenticated read access via `/api/public/*` routes and auto-login from the public view.
- All media stored in Cloudinary under the `photostream/` folder prefix. Images and videos are fetched separately and merged/sorted by `created_at`.
- `pinnedImage` is an in-memory server-side state (2 h TTL) that lets an admin "pin" a specific image to the public live view (`/api/public/latest`). A new upload clears the pin automatically.
- The `/api/download` proxy enforces `*.cloudinary.com` domain to prevent SSRF.
- Self-ping every 10 min when `process.env.PORT` is set (Render.com keep-alive).

**`public/app.js`** — all frontend logic in one file, no bundler:
- `state` object holds auth token, image list, viewer index, lightbox index.
- Separate `gallery` object tracks paginated gallery state (cursor, loaded items, total).
- Polling: every 5 s hits `/api/images/latest`; only fetches full list if timestamp or count changed.
- Index ordering: `state.images[0]` is always the **most recent** item. "Next" = lower index, "Prev" = higher index.
- The `FROM_PUBLIC` / `PV_TOKEN` flags detect when the app was opened from the public view via `?from=public-view&pvtoken=...` query params — this triggers auto-login and redirects back after pinning.
- Gallery uses cursor-based pagination (`/api/images/page`) to avoid hitting Cloudinary API limits; the full list (`/api/images`) is still fetched separately for the viewer/polling.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_USER` / `AUTH_PASS` | `admin` / `admin` | Admin login credentials |
| `PUBLIC_VIEW_TOKEN` | `photostream` | Token for public/unauthenticated access |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | hardcoded in server.js | Cloudinary credentials |
| `PORT` | `3000` | Server port |
| `RENDER_EXTERNAL_URL` | — | Used for self-ping URL on Render |
| `STABILITY_API_KEY` | — | Stability AI (currently disabled) |

> As credenciais do Cloudinary ficam no `.env` (local) e nas env vars do Render (produção). Nunca commitar o `.env`.

## Disabled Feature

The Stability AI image processing feature is commented out. To re-enable it:
1. Uncomment the `.ai-prompt-wrap` block in `public/index.html`
2. Restore the `.ai-prompt-wrap` CSS in `public/style.css`
3. Re-add the `aiPrompt` field to the `sendUpload` FormData in `public/app.js`
4. Set `STABILITY_API_KEY` env var
