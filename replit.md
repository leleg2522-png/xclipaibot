# Telegram Bot - Freepik AI Video Generator

## Overview
A Telegram bot that interfaces with the Freepik AI API for generating videos from images (Image-to-Video) and motion control using models like Kling and Wan.

## Purpose on Replit
This project is used as a **code editor only**. The bot runs on Railway. Replit is connected to the Railway PostgreSQL database for development/editing purposes.

## Structure
- `index.js` — Main bot logic: Telegram interactions, Freepik API, database management, Express webhook server
- `package.json` — Node.js dependencies
- `Dockerfile` — Docker config for Railway deployment
- `setup-proxy.sh` — Proxy setup script for VPS

## Key Dependencies
- `node-telegram-bot-api` — Telegram bot library
- `axios` — HTTP client for Freepik API
- `express` — Webhook and file server
- `pg` — PostgreSQL client
- `bcryptjs` — Password hashing
- `https-proxy-agent` — Proxy support

## Environment Variables
- `RAILWAY_DATABASE_URL` — Railway PostgreSQL connection string (configured)
- `TELEGRAM_BOT_TOKEN` — Bot token (only needed if running the bot locally)
- `ADMIN_TELEGRAM_IDS` — Admin user IDs (only needed if running the bot locally)

## Database
Connected to Railway PostgreSQL. Tables: `api_key_pool`, `user_api_keys`.
