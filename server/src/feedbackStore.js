import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
export const FEEDBACK_JSONL = path.join(DATA_DIR, 'feedback.jsonl');

function truncate(str, max) {
  if (typeof str !== 'string' || !str) return '';
  const t = str.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Persist one learner reaction so prompts / prompts tuning can evolve from real critiques.
 */
export async function appendFeedbackRecord(payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const line = JSON.stringify(payload) + '\n';
  await fs.appendFile(FEEDBACK_JSONL, line, 'utf8');
}

/**
 * Tail recent entries formatted for injection into the coach system prompt.
 */
export async function readFeedbackHintsForPrompt(options = {}) {
  const maxEntries = Number(process.env.FEEDBACK_CONTEXT_ENTRIES ?? options.maxEntries ?? 14);
  const maxChars = Number(process.env.FEEDBACK_CONTEXT_MAX_CHARS ?? options.maxChars ?? 1600);

  const disableContext =
    process.env.FEEDBACK_CONTEXT_INLINE === '0' ||
    process.env.FEEDBACK_CONTEXT_INLINE === 'false';

  if (disableContext) return '';

  try {
    const raw = await fs.readFile(FEEDBACK_JSONL, 'utf8');
    const lines = raw.split('\n').filter((ln) => ln.trim()).slice(-maxEntries);
    const parts = [];
    let len = 0;
    for (const ln of lines) {
      let row;
      try {
        row = JSON.parse(ln);
      } catch {
        continue;
      }
      const stars =
        typeof row.rating === 'number' ? `${row.rating}/5` : 'no rating';
      const comment = truncate(row.comment || '', 220);
      const lineTxt =
        comment
          ? `- [${stars}] Learner said: "${comment}"`
          : `- [${stars}] (stars only — no written note)`;

      if (len + lineTxt.length + 2 > maxChars) break;
      parts.push(lineTxt);
      len += lineTxt.length + 2;
    }
    return parts.join('\n');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}
