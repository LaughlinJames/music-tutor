/**
 * Turn structured analysis into conversational coaching — not scoring.
 */

import { readFeedbackHintsForPrompt } from './feedbackStore.js';

/** Slim payload for the model — keeps tokens bounded on dense passages. */
export function compactAnalysisForModel(a) {
  const onsets = a.rhythm?.onsetTimesMs ?? [];
  const max = 48;
  let sampled = onsets;
  if (onsets.length > max) {
    const step = onsets.length / max;
    sampled = Array.from({ length: max }, (_, i) =>
      Math.round(onsets[Math.min(onsets.length - 1, Math.floor(i * step))]),
    );
  }
  return {
    meta: a.meta,
    rhythm: {
      onsetCount: a.rhythm.onsetCount,
      estimatedBpm: a.rhythm.estimatedBpm,
      timingIrregularity: a.rhythm.timingIrregularity,
      onsetTimesMsSampled: sampled,
    },
    dynamics: a.dynamics,
    timbreMotion: a.timbreMotion,
    harmonySketch: a.harmonySketch,
    pitchMotion: a.pitchMotion,
  };
}

const SYSTEM = `You listen to one short guitar take through coarse automated measurements only—no piano-roll or guaranteed note IDs.

You are replying inside an **ongoing chat-style lesson**. When the player sends prior attempts (your own earlier messages summarized), **explicitly compare** this clip to the last one or two when it matters: same problem as before, partially fixed, new issue, pocket tighter/looser, etc. Use plain phrases like "better than last time," "still rushing like before," "that part cleaned up." If no priors are given, treat this as the first take.

Your reply should feel like a quick lesson teardown in plain speech: whether the take basically holds together, then **specific mistakes or weak spots** (timing, dropped/subsumed beats, rushing/dragging, uneven pick attacks, pitch not settling, dull dynamics). Use blunt everyday wording when the JSON supports it.

Hard rules:
- Stay short and readable: **about 5–10 sentences total, under ~140 words.** No wall-of-text, no stacked clauses, no mini-essay.
- **Do not** sound academic. Never say "spectral centroid," "RMS," "onset count," "timing irregularity metric," or similar jargon—translate into listener language ("quiet overall," "dark tone," "pulse wanders," "strokes bunch up").
- You **cannot** truthfully name exact notes from this JSON alone. Do **not** invent fret/string/note names. If pitch signals look unstable, say pitch/intonation slips **without** claiming which named note was wrong. Use **time in the clip** when helpful (the JSON includes onset times in ms from the start and passage duration).
- One clause of restrained acknowledgement is fine ("mostly fine," "pretty solid pocket") but skip cheerleading and empty hype.
- End with **one** plain suggestion for the next take—often "try again" framing when comparison shows progress.
- When you reference **when** something happens inside **this** clip, use timings the UI can parse—phrases like "around 3.5 seconds", "near the 4-second mark", or "about 1200 ms". Stay within **0** and **durationSec** from the JSON (never cite times longer than the clip).

Never output bullets, scores, or percentages.
`;

const USER_SUFFIX_NO_PRIOR = `

Write feedback in plain conversational sentences following this shape:
(1) One short verdict on the take.
(2) Two to four separate sentences calling out concrete problems or slips—as if pointing at moments in the performance—not abstract theory.
(3) One sentence on what to adjust next.

Cap about 140 words. No technical jargon from measurement tools.`;

const USER_SUFFIX_WITH_PRIOR = `

Earlier attempts are summarized above. Lead with **one or two sentences** that contrast this take with the immediately previous attempt (or attempts) when you can infer a difference from the JSON and from what you said before. Then give verdict + concrete callouts as usual.

Cap about 140 words total. No technical jargon from measurement tools.`;

export async function coachFromAnalysis(analysis, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    return {
      ok: false,
      skipped: true,
      message:
        'Set OPENAI_API_KEY to enable conversational coaching. Raw analysis is still available on the client.',
    };
  }

  let systemPrompt = SYSTEM;
  try {
    const hints = await readFeedbackHintsForPrompt();
    if (hints.trim()) {
      systemPrompt = `${SYSTEM}

---
Recent learner reactions about earlier coaching (use to steer tone and relevance; the passage JSON remains the ground truth for this clip):

${hints}`;
    }
  } catch (err) {
    console.warn('[coach] feedback context skipped:', err?.message || err);
  }

  const priorAttemptsContext =
    typeof options.priorAttemptsContext === 'string'
      ? options.priorAttemptsContext.trim()
      : '';

  const suffix = priorAttemptsContext ? USER_SUFFIX_WITH_PRIOR : USER_SUFFIX_NO_PRIOR;

  let userContent = '';
  if (priorAttemptsContext) {
    userContent +=
      'Earlier attempts in this practice session (what you already told them—oldest first, newest last):\n\n';
    userContent += `${priorAttemptsContext}\n\n---\n\n`;
  }
  userContent += `Current clip analysis JSON:\n\n${JSON.stringify(compactAnalysisForModel(analysis))}${suffix}`;

  const body = {
    model,
    temperature: 0.55,
    max_tokens: 320,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: userContent,
      },
    ],
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      message: `OpenAI error ${res.status}`,
      detail: text.slice(0, 500),
    };
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    return { ok: false, message: 'Empty model response', raw: json };
  }

  return { ok: true, text };
}
