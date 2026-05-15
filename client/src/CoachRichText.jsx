import { findTimeAnchors, playRecordingSlice } from './coachPlayback.js';

/**
 * Renders coach text with clickable time anchors when audio snapshot exists.
 */
export default function CoachRichText({ content, audioSnapshot }) {
  const anchors = findTimeAnchors(content);

  if (!anchors.length || !audioSnapshot?.samples?.length || !audioSnapshot.sampleRate) {
    return <span className="coach-plain">{content}</span>;
  }

  const clipDur = audioSnapshot.samples.length / audioSnapshot.sampleRate;
  const parts = [];
  let cursor = 0;

  anchors.forEach((a, idx) => {
    if (a.start > cursor) {
      parts.push(content.slice(cursor, a.start));
    }
    const label = content.slice(a.start, a.end);
    const t = Math.max(0, Math.min(a.seconds, clipDur));
    parts.push(
      <button
        key={`t-${a.start}-${idx}`}
        type="button"
        className="coach-time-link"
        aria-label={`Play phrase containing ${t.toFixed(2)} seconds`}
        title={`Play phrase containing ~${t.toFixed(2)}s`}
        onClick={() =>
          playRecordingSlice(audioSnapshot, t).catch(() => {
            /* autoplay / resume failures ignored */
          })
        }
      >
        {label}
      </button>,
    );
    cursor = a.end;
  });

  if (cursor < content.length) {
    parts.push(content.slice(cursor));
  }

  return <span className="coach-rich">{parts}</span>;
}
