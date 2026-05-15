/**
 * Lightweight musical descriptors from a mono PCM buffer.
 * Goal: feed an LLM *signals*, not a scorecard — tempo/onsets/dynamics/pitch motion.
 */
import Meyda from 'meyda';
import Pitchfinder from 'pitchfinder';

const BPM_MIN = 60;
const BPM_MAX = 220;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const v = mean(values.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

/** RMS envelope for onset-ish peaks */
function rmsEnvelope(samples, frameSize, hop) {
  const out = [];
  for (let i = 0; i + frameSize <= samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = samples[i + j];
      sum += s * s;
    }
    out.push(Math.sqrt(sum / frameSize));
  }
  return out;
}

function detectOnsets(envelope, hopSamples, sampleRate) {
  if (envelope.length < 4) return [];

  const smoothed = envelope.map((_, idx) => {
    const a = envelope[idx - 1] ?? envelope[idx];
    const b = envelope[idx];
    const c = envelope[idx + 1] ?? envelope[idx];
    return (a + b + c) / 3;
  });

  const flux = [];
  for (let i = 1; i < smoothed.length; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    flux.push(Math.max(0, d));
  }

  const thresh = mean(flux) + 1.2 * (std(flux) ?? 0);
  const minSpacingMs = 80;
  const minSpacingFrames = Math.max(1, Math.round((minSpacingMs / 1000) * sampleRate / hopSamples));

  const peaks = [];
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] > flux[i - 1] && flux[i] >= flux[i + 1] && flux[i] > thresh) {
      peaks.push(i);
    }
  }

  const filtered = [];
  let last = -Infinity;
  for (const p of peaks) {
    if (p - last >= minSpacingFrames) {
      filtered.push(p);
      last = p;
    }
  }

  return filtered.map((f) => ((f * hopSamples) / sampleRate) * 1000);
}

function tempoFromOnsets(timesMs) {
  if (timesMs.length < 3) return null;
  const intervals = [];
  for (let i = 1; i < timesMs.length; i++) {
    const dt = timesMs[i] - timesMs[i - 1];
    if (dt > 180 && dt < 2000) intervals.push(dt);
  }
  if (!intervals.length) return null;
  const med = median(intervals);
  if (!med || med <= 0) return null;
  const bpm = 60000 / med;
  if (bpm < BPM_MIN || bpm > BPM_MAX) return null;
  return Math.round(bpm * 10) / 10;
}

function rhythmConsistency(timesMs) {
  if (timesMs.length < 4) return null;
  const intervals = [];
  for (let i = 1; i < timesMs.length; i++) {
    intervals.push(timesMs[i] - timesMs[i - 1]);
  }
  const med = median(intervals);
  if (!med || med <= 0) return null;
  const rel = intervals.map((dt) => Math.abs(dt - med) / med);
  return Math.round(mean(rel) * 1000) / 1000;
}

function summarizePitch(samples, sampleRate) {
  const detect = Pitchfinder.YIN({ sampleRate });
  const hop = Math.floor(sampleRate * 0.02);
  const frame = Math.floor(sampleRate * 0.05);
  const freqs = [];
  const centsSeries = [];

  for (let i = 0; i + frame <= samples.length; i += hop) {
    const slice = samples.subarray(i, i + frame);
    const f = detect(slice);
    if (f && f > 70 && f < 1200) {
      freqs.push(f);
      centsSeries.push(1200 * Math.log2(f / 440));
    }
  }

  if (freqs.length < 3) {
    return {
      voicedFrames: freqs.length,
      medianHz: null,
      pitchMotionSemitones: null,
      pitchInstabilityCents: null,
    };
  }

  const motion = [];
  for (let i = 1; i < centsSeries.length; i++) {
    motion.push(Math.abs(centsSeries[i] - centsSeries[i - 1]));
  }

  return {
    voicedFrames: freqs.length,
    medianHz: Math.round(median(freqs) * 10) / 10,
    pitchMotionSemitones: Math.round(mean(motion) / 100 * 1000) / 1000,
    pitchInstabilityCents: Math.round(std(centsSeries) ?? 0),
  };
}

export function analyzeAudio(samples, sampleRate) {
  const safeRate = sampleRate > 0 ? sampleRate : 44100;
  const bufferSize = 2048;
  const hopSize = 1024;

  if (!(samples instanceof Float32Array)) {
    samples = Float32Array.from(samples);
  }

  Meyda.bufferSize = bufferSize;
  Meyda.sampleRate = safeRate;

  const rmsList = [];
  const centroidList = [];
  const zcrList = [];
  const chromaAccum = new Array(12).fill(0);
  let chromaFrames = 0;

  for (let i = 0; i + bufferSize <= samples.length; i += hopSize) {
    const slice = samples.subarray(i, i + bufferSize);
    const feat = Meyda.extract(['rms', 'spectralCentroid', 'zcr', 'chroma'], slice);
    if (!feat) continue;
    if (typeof feat.rms === 'number') rmsList.push(feat.rms);
    if (typeof feat.spectralCentroid === 'number') centroidList.push(feat.spectralCentroid);
    if (typeof feat.zcr === 'number') zcrList.push(feat.zcr);
    if (feat.chroma && feat.chroma.length === 12) {
      for (let c = 0; c < 12; c++) chromaAccum[c] += feat.chroma[c];
      chromaFrames++;
    }
  }

  const envelope = rmsEnvelope(samples, Math.floor(safeRate * 0.02), Math.floor(safeRate * 0.01));
  const onsetTimesMs = detectOnsets(envelope, Math.floor(safeRate * 0.01), safeRate);
  const estimatedBpm = tempoFromOnsets(onsetTimesMs);
  const timingIrregularity = rhythmConsistency(onsetTimesMs);

  const chromaMean = chromaFrames
    ? chromaAccum.map((v) => v / chromaFrames)
    : null;
  let chromaPeakPitchClass = null;
  if (chromaMean) {
    let max = -Infinity;
    let idx = 0;
    for (let i = 0; i < 12; i++) {
      if (chromaMean[i] > max) {
        max = chromaMean[i];
        idx = i;
      }
    }
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    chromaPeakPitchClass = names[idx];
  }

  const pitch = summarizePitch(samples, safeRate);

  const durationSec = samples.length / safeRate;

  const rmsEarly = rmsList.slice(0, Math.floor(rmsList.length / 3));
  const rmsLate = rmsList.slice(-Math.floor(rmsList.length / 3));

  const energyTrend =
    rmsEarly.length && rmsLate.length
      ? Math.round(((mean(rmsLate) - mean(rmsEarly)) / (mean(rmsEarly) || 1e-6)) * 1000) / 1000
      : null;

  return {
    meta: {
      durationSec: Math.round(durationSec * 100) / 100,
      sampleRate: safeRate,
      analyzedSamples: samples.length,
    },
    rhythm: {
      onsetTimesMs,
      onsetCount: onsetTimesMs.length,
      estimatedBpm,
      /** Mean absolute deviation of IOIs vs median IOI (rough swing/stability proxy). */
      timingIrregularity,
    },
    dynamics: {
      rmsMean: rmsList.length ? Math.round(mean(rmsList) * 10000) / 10000 : null,
      rmsStd: rmsList.length ? Math.round((std(rmsList) ?? 0) * 10000) / 10000 : null,
      energyTrendEarlyToLate: energyTrend,
    },
    timbreMotion: {
      spectralCentroidMeanHz: centroidList.length ? Math.round(mean(centroidList)) : null,
      zcrMean: zcrList.length ? Math.round(mean(zcrList) * 1000) / 1000 : null,
    },
    harmonySketch: {
      chromaPeakPitchClass,
      chromaSpread:
        chromaMean && chromaMean.length
          ? Math.round(std(chromaMean) * 1000) / 1000
          : null,
    },
    pitchMotion: pitch,
  };
}
