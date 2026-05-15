# AI Guitar Coach (MVP scaffold)

Web-based proof-of-concept: browser captures short clips → WebSocket → Node analysis (tempo/onsets/dynamics/pitch motion) → OpenAI produces **conversational** coaching (no scores).

## Quick start

```bash
cd music-tutor
npm install
cp server/.env.example server/.env
# Add OPENAI_API_KEY to server/.env (optional — analysis still runs without it)

# Terminal 1
npm run dev -w server

# Terminal 2
npm run dev -w client
```

Open **http://localhost:5173**. The Vite dev server proxies WebSocket `/ws` to the API port from **`server/.env`** (`PORT`, default **`37891`** — see `server/default-port.js`).

### “Failed running src/index.js” / server exits immediately

Usually **`EADDRINUSE`**: something else is already bound to that port (often an old `music-tutor-server`). Check with:

```bash
lsof -nP -iTCP:37891 | grep LISTEN
```

Stop that PID, or set **`PORT=`** to another free port in **`server/.env`** — `vite.config.js` reads the same file so the proxy stays in sync.

Or run both: `npm run dev` (requires root `concurrently`).

## Layout

| Path | Role |
|------|------|
| `server/src/index.js` | Express + `ws` binary audio frames |
| `server/src/analysis.js` | Meyda + onset heuristic + **pitchfinder** (YIN) |
| `server/src/openai.js` | Chat completion + session prior replies + feedback hints |
| `server/src/feedbackStore.js` | Append/read `server/data/feedback.jsonl` |
| `server/src/sessionStore.js` | Practice threads in `server/data/sessions/<uuid>.json` |
| `client/` | Vite + React; `public/recorder-worklet.js` taps PCM |

After each response you can rate the coaching; entries are saved locally and **recent comments are summarized into the coach’s system prompt** on this machine (disable with `FEEDBACK_CONTEXT_INLINE=false` in `server/.env`). **Each browser session id** (see localStorage) maps to a **server-side transcript** of past clips’ coaching text so the model can compare tries (“better than last time…”).

## Audio wire format (POC)

Binary WebSocket message:

- bytes `0–3`: `sampleRate` uint32 LE  
- bytes `4–7`: `sampleCount` uint32 LE  
- bytes `8–`: `sampleCount` × float32 LE mono PCM  

---

See the architecture overview, library notes, and latency guidance in this repo’s initial design conversation.
