import { useCallback, useEffect, useRef, useState } from 'react';
import CoachRichText from './CoachRichText.jsx';
import './App.css';

const SESSION_STORAGE_KEY = 'music-tutor-session-id';

function ensureSessionId() {
  let id = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, id);
  }
  return id;
}

function drawLiveWaveform(canvas, timeDomain) {
  if (!canvas || !timeDomain?.length) return;
  const c = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  c.fillStyle = '#0b0c10';
  c.fillRect(0, 0, w, h);

  const mid = h / 2;
  const len = timeDomain.length;
  c.strokeStyle = '#c9a227';
  c.lineWidth = 1.25;
  c.beginPath();
  for (let x = 0; x < w; x++) {
    const idx = Math.min(len - 1, Math.floor((x / Math.max(1, w - 1)) * (len - 1)));
    const y = mid - timeDomain[idx] * mid * 0.92;
    if (x === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.stroke();

  c.strokeStyle = 'rgba(139, 147, 159, 0.35)';
  c.beginPath();
  c.moveTo(0, mid);
  c.lineTo(w, mid);
  c.stroke();
}

function drawWaveform(canvas, samples) {
  if (!canvas || !samples?.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0b0c10';
  ctx.fillRect(0, 0, w, h);

  const mid = h / 2;
  const step = Math.max(1, Math.floor(samples.length / w));
  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const i = Math.min(x * step, samples.length - 1);
    let peak = 0;
    for (let j = 0; j < step && i + j < samples.length; j++) {
      peak = Math.max(peak, Math.abs(samples[i + j]));
    }
    const y = mid - peak * mid * 0.92;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(139, 147, 159, 0.35)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

function mergeChunks(chunks) {
  const len = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Float32Array(len);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeAudioBinary(sampleRate, samples) {
  const buf = new ArrayBuffer(8 + samples.length * 4);
  const view = new DataView(buf);
  view.setUint32(0, sampleRate >>> 0, true);
  view.setUint32(4, samples.length >>> 0, true);
  new Float32Array(buf, 8).set(samples);
  return buf;
}

export default function App() {
  const [sessionId, setSessionId] = useState(ensureSessionId);
  const [messages, setMessages] = useState([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [coachText, setCoachText] = useState('');
  const [analysisJson, setAnalysisJson] = useState(null);
  const [coachMeta, setCoachMeta] = useState(null);

  const [rating, setRating] = useState(null);
  const [learnerComment, setLearnerComment] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState('idle');

  const chunksRef = useRef([]);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const audioRef = useRef(null);
  const recordingActiveRef = useRef(false);
  const vizRafRef = useRef(0);
  const chatEndRef = useRef(null);

  const teardownAudio = useCallback(async () => {
    if (vizRafRef.current) {
      cancelAnimationFrame(vizRafRef.current);
      vizRafRef.current = 0;
    }
    const ctx = audioRef.current;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    teardownAudio();
    wsRef.current?.close();
  }, [teardownAudio]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (!analysisJson) return;
    setRating(null);
    setLearnerComment('');
    setFeedbackStatus('idle');
  }, [analysisJson]);

  const startNewSession = () => {
    const id = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, id);
    setSessionId(id);
    setMessages([]);
    setAnalysisJson(null);
    setCoachMeta(null);
    setCoachText('');
    setRating(null);
    setLearnerComment('');
    setFeedbackStatus('idle');
    setStatus('New session started — record when you are ready.');
  };

  const submitLearnerFeedback = async () => {
    const hasStars = typeof rating === 'number';
    const trimmed = learnerComment.trim();
    if (!hasStars && trimmed.length < 4) return;

    setFeedbackStatus('sending');
    try {
      const coachHadError = Boolean(
        coachMeta && coachMeta.ok !== true && coachMeta.skipped !== true,
      );
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: hasStars ? rating : null,
          comment: trimmed || undefined,
          coachText: coachText || undefined,
          coachHadError,
          analysisSummary: analysisJson
            ? {
                durationSec: analysisJson.meta?.durationSec,
                estimatedBpm: analysisJson.rhythm?.estimatedBpm,
                onsetCount: analysisJson.rhythm?.onsetCount,
              }
            : undefined,
        }),
      });
      if (!res.ok) {
        setFeedbackStatus('error');
        return;
      }
      setFeedbackStatus('sent');
    } catch {
      setFeedbackStatus('error');
    }
  };

  const appendChatPair = useCallback(
    (userContent, assistantContent, isError = false, audioSnapshot = null) => {
      const uid = () => crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'user', content: userContent },
        {
          id: uid(),
          role: 'assistant',
          content: assistantContent,
          isError,
          audioSnapshot,
        },
      ]);
    },
    [],
  );

  const stopRecording = useCallback(async () => {
    if (!recordingActiveRef.current) return;
    recordingActiveRef.current = false;
    setRecording(false);

    if (vizRafRef.current) {
      cancelAnimationFrame(vizRafRef.current);
      vizRafRef.current = 0;
    }

    const ctx = audioRef.current;
    const processor = ctx?.processorNode;
    const analyser = ctx?.analyserNode;
    const stream = ctx?.mediaStream;
    const source = ctx?.sourceNode;

    processor?.port?.close?.();
    processor?.disconnect();
    analyser?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());

    const merged = mergeChunks(chunksRef.current);
    chunksRef.current = [];

    await teardownAudio();

    if (!merged.length) {
      setStatus('No audio captured — check microphone permissions.');
      return;
    }

    const mergedCopy = new Float32Array(merged);

    drawWaveform(canvasRef.current, merged);
    const sr = ctx?.sampleRate || 48000;
    const clipDurationSec = Math.round((merged.length / sr) * 100) / 100;

    if (merged.length < sr * 0.4) {
      setStatus('Clip too short — play at least a few seconds for tempo/onset hints.');
    } else {
      setStatus('Sending clip…');
    }

    setBusy(true);
    setCoachText('');
    setAnalysisJson(null);
    setCoachMeta(null);

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${wsProto}//${window.location.host}/ws`;

    const failAssistant = (text) => {
      appendChatPair(`Played ~${clipDurationSec}s — listening…`, text, true);
      setStatus(text);
    };

    const send = () => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'configure', sessionId }));
        ws.send(encodeAudioBinary(sr, merged));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'result') {
            setAnalysisJson(msg.analysis);
            const coach = msg.coach;
            setCoachMeta(coach);

            const dur = msg.analysis?.meta?.durationSec ?? clipDurationSec;
            const bpm = msg.analysis?.rhythm?.estimatedBpm;
            const attemptNote =
              typeof msg.attemptNumber === 'number'
                ? ` · Attempt ${msg.attemptNumber}`
                : '';

            const userLine = `Played ~${dur}s${bpm != null ? ` · ~${bpm} BPM` : ''}${attemptNote}`;
            let assistantLine =
              coach?.ok && coach.text
                ? coach.text
                : coach?.skipped
                  ? coach.message ||
                    'Coaching skipped — add OPENAI_API_KEY on the server.'
                  : coach?.message || 'Could not generate coaching for this clip.';

            setCoachText(coach?.ok && coach.text ? coach.text : '');
            const rhythm = msg.analysis?.rhythm;
            appendChatPair(userLine, assistantLine, false, {
              samples: mergedCopy,
              sampleRate: sr,
              onsetTimesMs: Array.isArray(rhythm?.onsetTimesMs) ? rhythm.onsetTimesMs : undefined,
            });
            setStatus(
              coach?.ok ? 'Coach replied — record again to continue the session.' : 'Reply ready.',
            );
          } else if (msg.type === 'error') {
            failAssistant(msg.message || 'Server error during analysis.');
          }
        } catch {
          failAssistant('Bad response from server.');
        } finally {
          setBusy(false);
          ws.close();
          wsRef.current = null;
        }
      };

      ws.onerror = () => {
        setBusy(false);
        failAssistant(
          'WebSocket error — is the API running? Check the dev terminal for the listening port.',
        );
        wsRef.current = null;
      };
    };

    send();
  }, [teardownAudio, sessionId, appendChatPair]);

  const startRecording = async () => {
    setCoachText('');
    setAnalysisJson(null);
    setCoachMeta(null);
    chunksRef.current = [];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    const ctx = new AudioContext();
    await ctx.resume();

    await ctx.audioWorklet.addModule('/recorder-worklet.js');

    const source = ctx.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    processor.port.onmessage = (ev) => {
      const data = ev.data;
      if (data instanceof Float32Array) {
        chunksRef.current.push(data);
      }
    };

    source.connect(processor);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);

    const timeDomainBuf = new Float32Array(analyser.fftSize);

    const tick = () => {
      if (!recordingActiveRef.current) return;
      const ar = audioRef.current;
      if (!ar?.analyserNode || !ar.timeDomainBuf) return;
      ar.analyserNode.getFloatTimeDomainData(ar.timeDomainBuf);
      drawLiveWaveform(canvasRef.current, ar.timeDomainBuf);
      vizRafRef.current = requestAnimationFrame(tick);
    };

    audioRef.current = {
      ctx,
      processorNode: processor,
      analyserNode: analyser,
      sourceNode: source,
      mediaStream: stream,
      sampleRate: ctx.sampleRate,
      timeDomainBuf,
    };

    vizRafRef.current = requestAnimationFrame(tick);

    recordingActiveRef.current = true;
    setRecording(true);
    setStatus("Recording… click Stop when you're finished.");
  };

  return (
    <div className="layout">
      <header className="app-header">
        <div className="header-copy">
          <h1>AI Guitar Coach</h1>
          <p>
            Chat-style session: each recording is your message; the coach remembers earlier tries in
            this session so it can compare takes (for example, better pocket than last time but still
            rushing).
          </p>
        </div>
        <button type="button" className="btn btn-secondary new-session-btn" onClick={startNewSession}>
          New session
        </button>
      </header>

      <section className="visual-panel">
        <h2 className="waveform-heading">
          Live input
          {recording && <span className="waveform-live">Listening</span>}
        </h2>
        <div className="waveform-wrap">
          <canvas ref={canvasRef} width={880} height={120} />
        </div>
      </section>

      <section className="chat-panel">
        <div className="chat-panel-head">
          <h2 className="chat-panel-title">Session chat</h2>
          <span className="session-id-hint" title={sessionId}>
            Session saved on server
          </span>
        </div>
        <div className="chat-shell">
          {messages.length === 0 && !busy && (
            <p className="chat-empty">
              Record a phrase below — it shows up here as your side of the chat, then the coach
              replies.
            </p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-row chat-row-${m.role}`}>
              <div
                className={`chat-bubble chat-bubble-${m.role} ${m.isError ? 'chat-bubble-error' : ''}`}
              >
                <div className="chat-bubble-label">{m.role === 'user' ? 'You · audio' : 'Coach'}</div>
                <div className="chat-bubble-text">
                  {m.role === 'assistant' && !m.isError ? (
                    <CoachRichText content={m.content} audioSnapshot={m.audioSnapshot} />
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            </div>
          ))}
          {busy && (
            <div className="chat-row chat-row-assistant">
              <div className="chat-bubble chat-bubble-assistant chat-bubble-typing">
                <div className="chat-bubble-label">Coach</div>
                <div className="chat-bubble-text">Thinking…</div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      </section>

      <section className="composer">
        <button
          type="button"
          className={`btn btn-record ${recording ? 'recording btn-secondary' : 'btn-primary'}`}
          onClick={() => {
            if (recording) stopRecording();
            else startRecording();
          }}
          disabled={busy}
        >
          {recording ? 'Stop & send' : 'Record'}
        </button>
        <p className="status composer-status">{status}</p>
      </section>

      <section className="feedback-panel">
        {!busy && analysisJson && (
          <div className="learner-feedback-box" aria-live="polite">
            <h3 className="learner-feedback-title">Rate last reply</h3>
            <p className="learner-feedback-hint">
              Stars + notes improve coaching globally on this machine (
              <code>server/data/feedback.jsonl</code>). Session memory lives in{' '}
              <code>server/data/sessions/</code>.
            </p>
            <div className="star-row" role="group" aria-label="Rating 1 to 5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`star-btn ${typeof rating === 'number' && rating >= n ? 'star-btn-on' : ''}`}
                  disabled={feedbackStatus === 'sending' || feedbackStatus === 'sent'}
                  aria-pressed={typeof rating === 'number' && rating >= n}
                  aria-label={`${n} out of 5`}
                  onClick={() => setRating((prev) => (prev === n ? null : n))}
                >
                  ★
                </button>
              ))}
            </div>
            <label className="learner-feedback-label" htmlFor="fb-comment">
              Feedback on this coaching (optional)
            </label>
            <textarea
              id="fb-comment"
              className="learner-feedback-textarea"
              rows={3}
              placeholder="e.g. Still too vague / comparison with last take was useful."
              value={learnerComment}
              disabled={feedbackStatus === 'sending' || feedbackStatus === 'sent'}
              onChange={(e) => setLearnerComment(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary learner-feedback-submit"
              disabled={
                feedbackStatus === 'sending' ||
                feedbackStatus === 'sent' ||
                (rating == null && learnerComment.trim().length < 4)
              }
              onClick={submitLearnerFeedback}
            >
              {feedbackStatus === 'sending'
                ? 'Saving…'
                : feedbackStatus === 'sent'
                  ? 'Saved'
                  : 'Send feedback'}
            </button>
            {feedbackStatus === 'error' && (
              <p className="learner-feedback-error">Could not save — try again.</p>
            )}
            {feedbackStatus === 'sent' && (
              <p className="learner-feedback-sent">
                Saved. Recent notes are summarized into the coach&apos;s instructions on this machine.
              </p>
            )}
          </div>
        )}

        {analysisJson && (
          <div className="metrics">
            <details>
              <summary>Raw analysis JSON</summary>
              <pre>{JSON.stringify(analysisJson, null, 2)}</pre>
            </details>
          </div>
        )}
      </section>
    </div>
  );
}
