# AI Guitar Coach

A web-based proof-of-concept for an AI music coach that listens to short guitar passages and gives conversational feedback about feel, groove, phrasing, dynamics, and musical expression.

This is intentionally **not** a note-policing or gamified scoring app. The goal is to feel more like a musician listening back with you and saying:

> “the pocket tightened up there,”  
> “your attack got uneven,”  
> “that phrase started to rush as the energy built.”

---

# What it does

- Captures live audio from the browser microphone
- Sends short recordings to a Node/Express backend over WebSocket
- Extracts lightweight musical signals:
  - onset timing
  - estimated tempo
  - timing irregularity
  - dynamics / energy trend
  - pitch motion
  - rough timbre and harmony descriptors
- Sends structured analysis to an OpenAI model
- Returns conversational coaching feedback
- Remembers prior takes in the same session
- Lets the learner rate feedback for future tuning

---

# Why this exists

Most music-learning software focuses on correctness:

> Did you play the right note at the right time?

This project explores a different question:

> Can AI help a musician understand the *feel* of their playing?

The long-term vision is an AI practice companion for musicians who care about:
- groove
- phrasing
- tone
- dynamics
- confidence
- expressive intent

—not just accuracy.

---

# Current architecture

```text
Browser microphone
   ↓
React + WebAudio API
   ↓
AudioWorklet captures mono PCM
   ↓
WebSocket binary frame
   ↓
Node / Express / ws server
   ↓
Meyda + Pitchfinder analysis
   ↓
Structured musical JSON
   ↓
OpenAI coaching prompt
   ↓
Conversational lesson feedback
```

---

# Tech stack

## Client

- React
- Vite
- WebAudio API
- AudioWorklet
- Canvas waveform visualization

## Server

- Node.js
- Express
- ws
- Meyda
- Pitchfinder
- OpenAI Chat Completions API

---

# Project layout

```text
music-tutor/
├── client/
│   ├── public/
│   │   └── recorder-worklet.js
│   └── src/
│       ├── App.jsx
│       ├── CoachRichText.jsx
│       └── App.css
├── server/
│   ├── src/
│   │   ├── index.js
│   │   ├── analysis.js
│   │   ├── openai.js
│   │   ├── feedbackStore.js
│   │   └── sessionStore.js
│   ├── data/
│   │   ├── feedback.jsonl
│   │   └── sessions/
│   └── .env.example
├── package.json
└── README.md
```

---

# Quick start

Clone the repo:

```bash
git clone https://github.com/LaughlinJames/music-tutor.git
cd music-tutor
```

Install dependencies:

```bash
npm install
```

Create the server environment file:

```bash
cp server/.env.example server/.env
```

Add your OpenAI API key to `server/.env`:

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4o-mini
PORT=37891
```

Start the app:

```bash
npm run dev
```

Then open:

```text
http://localhost:5173
```

---

# Running client and server separately

Terminal 1:

```bash
npm run dev -w server
```

Terminal 2:

```bash
npm run dev -w client
```

---

# Audio wire format

The browser sends one binary WebSocket message per recorded passage.

```text
bytes 0–3   sampleRate    uint32 little-endian
bytes 4–7   sampleCount   uint32 little-endian
bytes 8+    samples       float32 little-endian mono PCM
```

The server:
1. Parses the buffer
2. Analyzes the audio
3. Generates coaching
4. Stores the attempt
5. Returns JSON to the client

---

# Session memory

Each browser session gets a UUID stored in `localStorage`.

The server stores previous coaching attempts in:

```text
server/data/sessions/
```

This allows the coach to compare takes:

> “Better than last time — the pulse is steadier, but the ending still compresses a bit.”

---

# Feedback memory

Learner ratings and comments are saved locally in:

```text
server/data/feedback.jsonl
```

Recent feedback can be summarized into the coach prompt so the system can adapt over time.

To disable feedback context injection:

```bash
FEEDBACK_CONTEXT_INLINE=false
```

---

# Current limitations

This is an early proof-of-concept.

It does **not** yet provide:
- reliable note-level transcription
- chord recognition
- fretboard analysis
- true low-latency continuous coaching

The current analysis is intentionally coarse and should be treated as musical signal, not ground truth.

The coaching layer is designed to translate rough musical measurements into useful human feedback.

---

# Product philosophy

The core idea is:

> Measure enough to stay grounded, but respond like a musician.

Good feedback should be:
- specific
- plainspoken
- musical
- honest
- encouraging without being fake
- focused on the next useful take

Bad feedback is:
- generic praise
- fake precision
- academic jargon
- scores and percentages
- “wrong note” policing

---

# Example coaching style

Good:

> This mostly holds together, but the pulse starts to bunch up near the middle. Your attack gets sharper as the phrase gets louder, which adds energy but also makes the groove feel less settled. For the next take, try playing it a little quieter and keep the right hand relaxed through the busier moments.

Not the goal:

> Your performance scored 82%. You missed three notes. Try again.

---

# Development notes

If the server fails to start, the default port may already be in use.

Check:

```bash
lsof -nP -iTCP:37891 | grep LISTEN
```

Either stop that process or change `PORT` in `server/.env`.

---

# Roadmap ideas

- Better phrase segmentation
- More reliable tempo and beat tracking
- Improved onset detection for acoustic guitar
- Per-section feedback tied to timestamps
- Clip playback with marked moments
- Side-by-side attempt comparison
- User-selectable coaching styles
- Instrument profiles
- Long-term practice history
- Video analysis for right-hand mechanics
- Eventually: true low-latency live coaching

---

# Status

Experimental MVP.

Built to explore whether structured audio analysis plus LLM interpretation can become a more human, expressive kind of AI music coach.