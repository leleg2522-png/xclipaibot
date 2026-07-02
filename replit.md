# Telegram Bot - AI Video Generator (Flora AI)

## Overview
A Telegram bot that generates videos using **Flora AI**, specifically the **Kling 2.6 Pro Motion Control** model. Users send a character photo plus a reference motion video, and the bot produces a video of the character performing that motion. Bot messages are in Indonesian.

## Purpose on Replit
This project runs directly on Replit. The "Start application" workflow runs `npm start` (Node.js) which starts the Telegram bot together with a small Express file/health server on port 5000.

## Structure
- `index.js` — Main bot logic: Telegram interactions, Flora AI API, multi-key pool management, Express file/health server
- `package.json` — Node.js dependencies (includes a `form-data` override)

## Flora AI integration
- Base URL: `https://app.flora.ai`, auth via `Authorization: Bearer <FLORA_API_KEY>`.
- Model discovery: `GET /api/v1/models` → the "Kling 2.6 Pro Motion Control" endpoint id is `iv2v-kling-2.6-motion` (discovered at runtime, cached).
- Context discovery per key: `GET /api/v1/workspaces` → `workspace_id`, `GET /api/v1/projects?workspace_id=...` → `project_id` (created if missing, cached per key).
- Submit: `POST /api/v1/generate` with body `{ type:"video", model, workspace_id, project_id, prompt, params:{ image_url, video_url, character_orientation } }`. **Media inputs must live inside the `params` map** — not in `inputs`/`parameters`.
- Poll: `GET` the returned `poll_url` until `status` is `completed`/`failed`; on completion, video URL is at `outputs[].url`.

## Multi-key pool system
- Flora API keys are stored in the `api_key_pool` table; each user is assigned keys from the pool (`user_api_keys`).
- On submit, keys are rotated. A dead/exhausted key (HTTP 401/402/403/429) is automatically replaced from the pool.
- Admins load keys in-bot via `/addkeys`; inspect with `/poolstatus`.

## Key Dependencies
- `node-telegram-bot-api` — Telegram bot library
- `axios` — HTTP client for the Flora API
- `express` — File/health server
- `pg` — PostgreSQL client
- `bcryptjs` — Password hashing

## Environment Variables / Secrets
- `FLORA_API_KEY` — a Flora AI API key (used for model/context discovery; per-user generation uses pooled keys). Configured.
- `DATABASE_URL` — PostgreSQL connection string. Configured.
- `TELEGRAM_BOT_TOKEN` — Telegram bot token from @BotFather. **Required for the bot to run.**
- `ADMIN_TELEGRAM_IDS` — comma-separated Telegram user IDs allowed to use admin commands (`/addkeys`, `/poolstatus`).
- `REPLIT_DEV_DOMAIN` — used to build public URLs for uploaded media (runtime-provided).

## Database
PostgreSQL. Tables: `api_key_pool`, `user_api_keys`.

## User limits
- Daily limit: 20 generations per user.
- Cooldown: 5 minutes between generations.

## User preferences
- Communicate with the user in Indonesian.
