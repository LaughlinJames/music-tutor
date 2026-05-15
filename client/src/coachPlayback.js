/**
 * Locate phrases like "4-second mark", "around 2.5 seconds", "1200 ms", "3s." in coach copy.
 */
export function findTimeAnchors(text) {
  if (typeof text !== 'string' || !text) return [];

  /** @type {{ start: number; end: number; seconds: number }[]} */
  const matches = [];

  /**
   * @param {RegExp} re
   * @param {(m: RegExpExecArray) => number | null} secondsFromMatch
   */
  function scan(re, secondsFromMatch) {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = r.exec(text)) !== null) {
      const seconds = secondsFromMatch(m);
      if (seconds == null || !Number.isFinite(seconds)) continue;
      if (seconds < 0 || seconds > 7200) continue;
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        seconds,
      });
    }
  }

  scan(/\b(\d+(?:\.\d+)?)\s*-?\s*seconds?(?:\s+mark)?\b/gi, (m) =>
    parseFloat(m[1]),
  );

  scan(
    /\b(?:near|around|after|before|past|by)\s+(?:the\s+)?(\d+(?:\.\d+)?)\s*-?\s*seconds?\b/gi,
    (m) => parseFloat(m[1]),
  );

  scan(/\bat\s+(?:about\s+)?(?:the\s+)?(\d+(?:\.\d+)?)\s*-?\s*(?:second|seconds|sec|secs)\b/gi, (m) =>
    parseFloat(m[1]),
  );

  scan(/\b(\d+(?:\.\d+)?)\s*(?:sec|secs)\b/gi, (m) => parseFloat(m[1]));

  scan(/\b(\d+(?:\.\d+)?)\s*ms\b/gi, (m) => parseFloat(m[1]) / 1000);

  scan(/\b(\d+(?:\.\d+)?)\s+s\b/gi, (m) => parseFloat(m[1]));

  scan(/\b(\d+\.\d+)s\b/gi, (m) => parseFloat(m[1]));

  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  /** Drop overlaps (keep earlier / wider span). */
  const merged = [];
  for (const x of matches) {
    const clash = merged.some((y) => !(x.end <= y.start || x.start >= y.end));
    if (!clash) merged.push(x);
  }
  merged.sort((a, b) => a.start - b.start);

  return merged;
}

let playbackCtx = null;
/** @type {AudioBufferSourceNode | null} */
let currentSource = null;

export function stopSnippetPlayback() {
  try {
    currentSource?.stop(0);
  } catch {
    /* ignore */
  }
  currentSource = null;
}

/** Long silence between attacks → likely phrase boundary (seconds). */
const PHRASE_GAP_SEC = 0.42;
const PRE_ROLL_SEC = 0.2;
const TAIL_PAD_SEC = 0.55;
/** When we lack onset structure, play at least this far forward (capped by clip end). */
const FALLBACK_FORWARD_SEC = 12;

/**
 * Find contiguous onset cluster around anchor using IOI ≤ phraseGap as same phrase.
 * @returns {{ startSec: number; endSec: number }}
 */
export function computePhraseWindow(snapshot, anchorSec) {
  const { samples, sampleRate, onsetTimesMs } = snapshot;
  const clipDur = samples.length / sampleRate;
  const c = Math.max(0, Math.min(anchorSec, clipDur));

  let onsets = [];
  if (Array.isArray(onsetTimesMs) && onsetTimesMs.length) {
    onsets = [
      ...new Set(
        onsetTimesMs.map((ms) => ms / 1000).filter((t) => Number.isFinite(t) && t >= 0 && t <= clipDur),
      ),
    ].sort((a, b) => a - b);
  }

  if (onsets.length >= 2) {
    let k = 0;
    let bestD = Infinity;
    for (let i = 0; i < onsets.length; i++) {
      const d = Math.abs(onsets[i] - c);
      if (d < bestD) {
        bestD = d;
        k = i;
      }
    }
    let left = k;
    let right = k;
    while (left > 0 && onsets[left] - onsets[left - 1] <= PHRASE_GAP_SEC) left--;
    while (right < onsets.length - 1 && onsets[right + 1] - onsets[right] <= PHRASE_GAP_SEC) right++;

    const startSec = Math.max(0, onsets[left] - PRE_ROLL_SEC);
    const endSec = Math.min(clipDur, onsets[right] + TAIL_PAD_SEC);
    if (endSec - startSec < 0.25) {
      return {
        startSec: Math.max(0, c - PRE_ROLL_SEC),
        endSec: Math.min(clipDur, c + FALLBACK_FORWARD_SEC),
      };
    }
    return { startSec, endSec };
  }

  const startSec = Math.max(0, c - PRE_ROLL_SEC);
  const endSec = Math.min(clipDur, c + FALLBACK_FORWARD_SEC);
  return { startSec, endSec };
}

/**
 * Play mono float PCM for the phrase containing `anchorSec`.
 */
export async function playRecordingSlice(snapshot, anchorSec) {
  const { samples, sampleRate } = snapshot;
  if (!(samples instanceof Float32Array) || samples.length === 0 || sampleRate <= 0) {
    return;
  }

  stopSnippetPlayback();

  const { startSec, endSec } = computePhraseWindow(snapshot, anchorSec);
  const clipDur = samples.length / sampleRate;
  const safeStart = Math.max(0, Math.min(startSec, clipDur));
  const safeEnd = Math.max(safeStart + 0.05, Math.min(endSec, clipDur));

  const i0 = Math.floor(safeStart * sampleRate);
  const i1 = Math.min(samples.length, Math.ceil(safeEnd * sampleRate));
  const len = Math.max(1, i1 - i0);
  const slice = samples.subarray(i0, i1);

  if (!playbackCtx) {
    playbackCtx = new AudioContext();
  }
  await playbackCtx.resume();

  const buf = playbackCtx.createBuffer(1, len, sampleRate);
  buf.copyToChannel(slice.length === len ? slice : Float32Array.from(slice), 0);

  const src = playbackCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playbackCtx.destination);
  currentSource = src;
  src.onended = () => {
    currentSource = null;
  };
  src.start();
}
