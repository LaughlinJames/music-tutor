import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');

function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

/** UUID v4 only — anything else maps to shared anonymous bucket (avoid path traversal). */
export function sanitizeSessionId(raw) {
  const s = String(raw ?? '').trim();
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  ) {
    return s;
  }
  return 'anonymous';
}

function truncate(str, max) {
  if (typeof str !== 'string') return '';
  const t = str.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export async function loadSession(rawId) {
  const id = sanitizeSessionId(rawId);
  try {
    const raw = await fs.readFile(sessionFile(id), 'utf8');
    const data = JSON.parse(raw);
    return {
      id,
      attempts: Array.isArray(data.attempts) ? data.attempts : [],
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { id, attempts: [] };
    }
    throw err;
  }
}

export async function appendAttempt(rawId, attempt) {
  const id = sanitizeSessionId(rawId);
  await fs.mkdir(SESSIONS_DIR, { recursive: true });

  let session = await loadSession(id);
  const now = new Date().toISOString();
  if (!session.createdAt) {
    session = { ...session, createdAt: now };
  }
  session.attempts.push(attempt);
  session.updatedAt = now;

  await fs.writeFile(sessionFile(id), JSON.stringify(session, null, 2), 'utf8');
  return session;
}

/**
 * Text block from *prior* attempts only (caller must not include the current clip yet).
 */
export function formatPriorAttemptsForPrompt(session, maxAttempts = 8) {
  const attempts = session.attempts.slice(-maxAttempts);
  if (!attempts.length) return '';

  return attempts
    .map((a, idx) => {
      const n = idx + 1 + Math.max(0, session.attempts.length - attempts.length);
      const bpm =
        a.estimatedBpm != null && Number.isFinite(a.estimatedBpm)
          ? `~${a.estimatedBpm} BPM`
          : 'tempo not locked';
      const coachBlock = truncate(a.coachText || '(no coaching text)', 420);
      return `Attempt ${n} (${a.durationSec ?? '?'}s clip, ${bpm}):\nYour earlier coaching:\n${coachBlock}`;
    })
    .join('\n\n---\n\n');
}
