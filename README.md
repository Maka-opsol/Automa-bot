---
title: MathU Bot
emoji: 🤖
colorFrom: blue
colorTo: green
sdk: docker
app_file: Dockerfile
pinned: false
---

# MathU Bot — Hugging Face Spaces Edition

Autonomous MathU question-solving bot running on Hugging Face Spaces (16GB RAM).

## Configuration

This Space uses a **Docker SDK** (not Gradio/Streamlit). The `Dockerfile`
builds a Node.js 20 image with Chrome + Playwright + SwiftShader (WebGL)
support. The bot runs entirely inside this container — no external browser
service needed.

## Environment Variables (set in Settings → Repository secrets)

Required secrets:
- `MATHU_USERNAME` — MathU account username
- `MATHU_PASSWORD` — MathU account password
- `TURSO_DATABASE_URL` — Turso libSQL database URL
- `TURSO_AUTH_TOKEN` — Turso auth token

AI provider keys (at least one):
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`
- `ZAI_API_KEY`
- `CLOUDFLARE_API_KEY`
- `NVIDIA_API_KEY`

Optional:
- `CLOUDINARY_CLOUD_NAME` — screenshot storage
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

## How it works

1. Bot starts, launches headless Chrome with SwiftShader (software WebGL)
2. Navigates to https://app.mathu.co.za (Flutter Web app)
3. CanvasKit compiles normally (16GB RAM handles the ~150MB spike easily)
4. Takes screenshots, sends to AI tribunal for question analysis
5. Executes actions (clicks, typing) to solve questions
6. Built-in self-ping keeps the Space awake (prevents 48h sleep)

## Architecture

```
┌─────────────────────────────────────────┐
│  Hugging Face Space (16GB RAM)          │
│                                         │
│  • Bot orchestrator (Node.js + tsx)     │
│  • Chrome + Playwright + SwiftShader   │
│  • CanvasKit (Flutter Web rendering)    │
│  • AI tribunal (Groq, OpenRouter, etc.)  │
│  • Turso DB client (cloud SQLite)       │
│                                         │
│  Port 7860 (HF requirement)             │
└─────────────────────────────────────────┘
         │
         └──────> Turso (cloud DB)
         └──────> app.mathu.co.za (Flutter Web)
         └──────> AI providers (Groq, etc.)
```

## Logs

Check the "Logs" tab in HF Spaces to see the bot's output.
