import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { DEFAULT_DEV_PORT } from '../default-port.js';
import { analyzeAudio } from './analysis.js';
import { coachFromAnalysis } from './openai.js';
import { appendFeedbackRecord } from './feedbackStore.js';
import {
  appendAttempt,
  formatPriorAttemptsForPrompt,
  loadSession,
  sanitizeSessionId,
} from './sessionStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const PORT = Number(process.env.PORT || DEFAULT_DEV_PORT);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/** Dev UX: API has no SPA — the React client runs on Vite (usually :5173). */
app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Music tutor API</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:2rem;line-height:1.5">
  <h1 style="font-size:1.1rem">This is the API server</h1>
  <p>You probably want the web app instead—when you run <code>npm run dev</code> from the repo root,
  open:</p>
  <p><strong><a href="http://localhost:5173/">http://localhost:5173/</a></strong></p>
  <p style="color:#555;font-size:.9rem">WebSocket analysis lives at <code>/ws</code> on this port (<code>${PORT}</code>).
  JSON health: <a href="/health"><code>/health</code></a>.</p>
</body></html>`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'music-tutor-api' });
});

app.post('/api/feedback', async (req, res) => {
  try {
    const body = req.body || {};
    const ratingRaw = body.rating;
    const commentRaw =
      typeof body.comment === 'string' ? body.comment.trim() : '';
    const coachTextRaw =
      typeof body.coachText === 'string' ? body.coachText : '';

    let rating = null;
    if (ratingRaw !== null && ratingRaw !== undefined && ratingRaw !== '') {
      const n = Number(ratingRaw);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        res.status(400).json({ ok: false, message: 'rating must be 1–5 or omitted' });
        return;
      }
      rating = n;
    }

    if (rating === null && commentRaw.length < 4) {
      res.status(400).json({
        ok: false,
        message: 'Pick a star rating or leave at least a short comment (a few words).',
      });
      return;
    }

    if (commentRaw.length > 4000) {
      res.status(400).json({ ok: false, message: 'Comment too long' });
      return;
    }

    const summary = body.analysisSummary;
    const signalsSummary =
      summary && typeof summary === 'object'
        ? {
            durationSec: summary.durationSec,
            estimatedBpm: summary.estimatedBpm,
            onsetCount: summary.onsetCount,
          }
        : undefined;

    const record = {
      receivedAt: new Date().toISOString(),
      rating,
      comment: commentRaw || undefined,
      coachSnippet: coachTextRaw ? coachTextRaw.slice(0, 1600) : undefined,
      signalsSummary,
      coachHadError:
        typeof body.coachHadError === 'boolean' ? body.coachHadError : undefined,
    };

    await appendFeedbackRecord(record);
    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback]', err);
    res.status(500).json({ ok: false, message: 'Could not save feedback' });
  }
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

function parseAudioBinary(buf) {
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sampleRate = view.getUint32(0, true);
  const length = view.getUint32(4, true);
  const expected = 8 + length * 4;
  if (length <= 0 || buf.byteLength !== expected) return null;
  return {
    sampleRate,
    samples: new Float32Array(buf.buffer, buf.byteOffset + 8, length),
  };
}

wss.on('connection', (socket) => {
  socket.sessionId = null;

  socket.on('message', async (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'configure' && msg.sessionId) {
          socket.sessionId = sanitizeSessionId(msg.sessionId);
          return;
        }
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
      return;
    }

    const parsed = parseAudioBinary(Buffer.from(data));
    if (!parsed) {
      socket.send(JSON.stringify({ type: 'error', message: 'Bad audio frame' }));
      return;
    }

    try {
      const analysis = analyzeAudio(parsed.samples, parsed.sampleRate);
      const sessionKey = socket.sessionId || 'anonymous';
      const session = await loadSession(sessionKey);
      const priorContext = formatPriorAttemptsForPrompt(session);
      const coach = await coachFromAnalysis(analysis, {
        priorAttemptsContext: priorContext,
      });

      const coachSnippet =
        coach?.ok && coach.text
          ? coach.text
          : coach?.skipped
            ? coach.message || ''
            : coach?.message || '';

      await appendAttempt(sessionKey, {
        at: new Date().toISOString(),
        durationSec: analysis.meta?.durationSec,
        estimatedBpm: analysis.rhythm?.estimatedBpm ?? null,
        onsetCount: analysis.rhythm?.onsetCount,
        timingIrregularity: analysis.rhythm?.timingIrregularity ?? null,
        coachText: coachSnippet,
        coachOk: coach?.ok === true,
      });

      socket.send(
        JSON.stringify({
          type: 'result',
          analysis,
          coach,
          sessionId: sanitizeSessionId(sessionKey),
          attemptNumber: session.attempts.length + 1,
        }),
      );
    } catch (err) {
      console.error(err);
      socket.send(
        JSON.stringify({
          type: 'error',
          message: err instanceof Error ? err.message : 'Analysis failed',
        }),
      );
    }
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[music-tutor-server] Port ${PORT} is already in use.\n` +
        `  • Stop the other process:  lsof -nP -iTCP:${PORT} | grep LISTEN\n` +
        `  • Or use another port: set PORT in server/.env (Vite reads the same file).`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Music tutor API + WS listening on http://localhost:${PORT}`);
});
