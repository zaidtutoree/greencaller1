const STORAGE_KEY = "selectedRingtone";
const CUSTOM_RINGTONE_KEY = "customRingtoneData";
const CUSTOM_RINGTONE_NAME_KEY = "customRingtoneName";

export interface RingtonePreset {
  id: string;
  name: string;
  description: string;
  type: "file" | "synth" | "custom";
}

// 10 built-in ringtones. "Default" (id "classic") is the current classic ring
// file; the rest are generated in-code (Web Audio) so no audio files are needed.
export const RINGTONE_PRESETS: RingtonePreset[] = [
  { id: "classic", name: "Default", description: "Classic phone ring", type: "file" },
  { id: "marimba", name: "Marimba", description: "Warm melodic wooden tone", type: "synth" },
  { id: "reflection", name: "Reflection", description: "Soft ascending chime", type: "synth" },
  { id: "ripple", name: "Ripple", description: "Gentle repeating bell pattern", type: "synth" },
  { id: "beacon", name: "Beacon", description: "Alternating two-tone ring", type: "synth" },
  { id: "chimes", name: "Chimes", description: "Bright bell arpeggio", type: "synth" },
  { id: "aurora", name: "Aurora", description: "Soft rising melody", type: "synth" },
  { id: "cascade", name: "Cascade", description: "Quick descending run", type: "synth" },
  { id: "pulse", name: "Pulse", description: "Steady rhythmic pulses", type: "synth" },
  { id: "crystal", name: "Crystal", description: "High shimmering bells", type: "synth" },
];

export function getRingtonePreference(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return "classic";
  // Fall back to Default if a stale/unknown id is stored.
  if (stored === "custom") return stored;
  return RINGTONE_PRESETS.some((p) => p.id === stored) ? stored : "classic";
}

export function setRingtonePreference(id: string): void {
  localStorage.setItem(STORAGE_KEY, id);
}

export function getCustomRingtone(): string | null {
  return localStorage.getItem(CUSTOM_RINGTONE_KEY);
}

export function getCustomRingtoneName(): string | null {
  return localStorage.getItem(CUSTOM_RINGTONE_NAME_KEY);
}

export function setCustomRingtone(dataUrl: string, fileName: string): void {
  localStorage.setItem(CUSTOM_RINGTONE_KEY, dataUrl);
  localStorage.setItem(CUSTOM_RINGTONE_NAME_KEY, fileName);
}

export function removeCustomRingtone(): void {
  localStorage.removeItem(CUSTOM_RINGTONE_KEY);
  localStorage.removeItem(CUSTOM_RINGTONE_NAME_KEY);
  if (getRingtonePreference() === "custom") {
    setRingtonePreference("classic");
  }
}

// ---------------------------------------------------------------------------
// Helpers for musical, phone-like ringtone synthesis
// ---------------------------------------------------------------------------

type BuildFn = (ctx: AudioContext, dest: AudioNode) => () => void;

function createSynthAudio(buildGraph: BuildFn): HTMLAudioElement {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const stop = buildGraph(ctx, dest);

  const audio = new Audio();
  audio.srcObject = dest.stream;

  const origPause = audio.pause.bind(audio);
  audio.pause = () => {
    origPause();
    stop();
    ctx.close().catch(() => {});
  };

  return audio;
}

// Play a single "struck" note with harmonics that decay naturally (like marimba / xylophone)
function playNote(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  startTime: number,
  duration: number,
  volume: number,
  oscillators: OscillatorNode[],
) {
  // Fundamental
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  // 1st overtone (octave above, softer) — gives warmth
  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = freq * 2;

  // 2nd overtone (adds brightness like a struck bar)
  const osc3 = ctx.createOscillator();
  osc3.type = "sine";
  osc3.frequency.value = freq * 4;

  const gain = ctx.createGain();
  const gain2 = ctx.createGain();
  const gain3 = ctx.createGain();

  // Natural struck-instrument envelope: fast attack, exponential decay
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  gain2.gain.setValueAtTime(0, startTime);
  gain2.gain.linearRampToValueAtTime(volume * 0.3, startTime + 0.008);
  gain2.gain.exponentialRampToValueAtTime(0.001, startTime + duration * 0.6);

  gain3.gain.setValueAtTime(0, startTime);
  gain3.gain.linearRampToValueAtTime(volume * 0.1, startTime + 0.005);
  gain3.gain.exponentialRampToValueAtTime(0.001, startTime + duration * 0.3);

  osc.connect(gain).connect(dest);
  osc2.connect(gain2).connect(dest);
  osc3.connect(gain3).connect(dest);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
  osc2.start(startTime);
  osc2.stop(startTime + duration + 0.05);
  osc3.start(startTime);
  osc3.stop(startTime + duration + 0.05);

  oscillators.push(osc, osc2, osc3);
}

// Play a soft bell / chime note
function playBell(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  startTime: number,
  duration: number,
  volume: number,
  oscillators: OscillatorNode[],
) {
  // Bell partials — slightly inharmonic for a bell-like shimmer
  const partials = [1, 2.76, 5.4, 8.93];
  const partialVolumes = [1, 0.5, 0.25, 0.12];

  partials.forEach((ratio, i) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq * ratio;

    const gain = ctx.createGain();
    const v = volume * partialVolumes[i];
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(v, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration * (1 - i * 0.15));

    osc.connect(gain).connect(dest);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
    oscillators.push(osc);
  });
}

// ---------------------------------------------------------------------------
// Generic melody scheduler — loops a phrase with a pause between repetitions.
// A frequency of 0 in the melody is treated as a rest.
// ---------------------------------------------------------------------------
interface MelodyOptions {
  melody: number[];
  noteDuration: number;
  noteGap: number;
  loopPause: number;
  volume: number;
  voice?: "note" | "bell";
  tail?: number;
}

function scheduleMelody(ctx: AudioContext, dest: AudioNode, opts: MelodyOptions): () => void {
  const oscillators: OscillatorNode[] = [];
  const now = ctx.currentTime;
  const step = opts.noteDuration + opts.noteGap;
  const loopLen = opts.melody.length * step + opts.loopPause;
  const play = opts.voice === "bell" ? playBell : playNote;

  for (let rep = 0; rep < 40; rep++) {
    const repStart = now + rep * loopLen;
    opts.melody.forEach((freq, i) => {
      if (freq > 0) {
        play(ctx, dest, freq, repStart + i * step, opts.noteDuration + (opts.tail || 0), opts.volume, oscillators);
      }
    });
  }

  return () => {
    oscillators.forEach((o) => {
      try { o.stop(); } catch { /* already stopped */ }
    });
  };
}

// ---------------------------------------------------------------------------
// Marimba — warm melodic pattern like a phone marimba ringtone
// ---------------------------------------------------------------------------
function buildMarimba(ctx: AudioContext, dest: AudioNode): () => void {
  const oscillators: OscillatorNode[] = [];
  const now = ctx.currentTime;

  //  Notes: D5  F#5  A5  D6  A5  F#5  D5  A4
  const melody = [587.33, 739.99, 880.0, 1174.66, 880.0, 739.99, 587.33, 440.0];
  const noteDuration = 0.18;
  const noteGap = 0.14; // time between note starts
  const phraseLen = melody.length * (noteDuration + noteGap);
  const loopLen = phraseLen + 1.2; // 1.2s pause between repetitions

  for (let rep = 0; rep < 60; rep++) {
    const repStart = now + rep * loopLen;
    melody.forEach((freq, i) => {
      playNote(ctx, dest, freq, repStart + i * (noteDuration + noteGap), noteDuration + 0.35, 0.22, oscillators);
    });
  }

  return () => {
    oscillators.forEach((o) => { try { o.stop(); } catch { /* noop */ } });
  };
}

// ---------------------------------------------------------------------------
// Reflection — gentle ascending and descending sine tones, dreamy and soft
// ---------------------------------------------------------------------------
function buildReflection(ctx: AudioContext, dest: AudioNode): () => void {
  const oscillators: OscillatorNode[] = [];
  const now = ctx.currentTime;

  // Ascending then descending: C5 E5 G5 B5 G5 E5
  const melody = [523.25, 659.25, 783.99, 987.77, 783.99, 659.25];
  const noteLen = 0.32;
  const noteGap = 0.12;
  const phraseLen = melody.length * (noteLen + noteGap);
  const loopLen = phraseLen + 1.5;

  for (let rep = 0; rep < 60; rep++) {
    const repStart = now + rep * loopLen;
    melody.forEach((freq, i) => {
      const t = repStart + i * (noteLen + noteGap);
      // Soft sine with gentle envelope
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.06);
      gain.gain.setValueAtTime(0.18, t + noteLen * 0.6);
      gain.gain.exponentialRampToValueAtTime(0.001, t + noteLen + 0.15);

      osc.connect(gain).connect(dest);
      osc.start(t);
      osc.stop(t + noteLen + 0.2);
      oscillators.push(osc);

      // Add a subtle octave-above shimmer
      const osc2 = ctx.createOscillator();
      osc2.type = "sine";
      osc2.frequency.value = freq * 2;
      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0, t);
      gain2.gain.linearRampToValueAtTime(0.04, t + 0.06);
      gain2.gain.exponentialRampToValueAtTime(0.001, t + noteLen);
      osc2.connect(gain2).connect(dest);
      osc2.start(t);
      osc2.stop(t + noteLen + 0.2);
      oscillators.push(osc2);
    });
  }

  return () => {
    oscillators.forEach((o) => { try { o.stop(); } catch { /* noop */ } });
  };
}

// ---------------------------------------------------------------------------
// Ripple — repeating bell chime, like a gentle doorbell pattern
// ---------------------------------------------------------------------------
function buildRipple(ctx: AudioContext, dest: AudioNode): () => void {
  const oscillators: OscillatorNode[] = [];
  const now = ctx.currentTime;

  // E5 C5 — E5 C5 — E5 G5 C6  (motif + resolution)
  const pattern = [
    { freq: 659.25, delay: 0 },
    { freq: 523.25, delay: 0.35 },
    { freq: 659.25, delay: 0.9 },
    { freq: 523.25, delay: 1.25 },
    { freq: 659.25, delay: 1.8 },
    { freq: 783.99, delay: 2.15 },
    { freq: 1046.5, delay: 2.5 },
  ];
  const loopLen = 4.2;

  for (let rep = 0; rep < 60; rep++) {
    const repStart = now + rep * loopLen;
    pattern.forEach(({ freq, delay }) => {
      playBell(ctx, dest, freq, repStart + delay, 0.9, 0.16, oscillators);
    });
  }

  return () => {
    oscillators.forEach((o) => { try { o.stop(); } catch { /* noop */ } });
  };
}

// ---------------------------------------------------------------------------
// Six additional generated ringtones (via scheduleMelody)
// ---------------------------------------------------------------------------
// Beacon — urgent alternating two-tone, like a classic cell ring
const buildBeacon: BuildFn = (ctx, dest) =>
  scheduleMelody(ctx, dest, {
    melody: [987.77, 0, 783.99, 0, 987.77, 0, 783.99, 0],
    noteDuration: 0.2, noteGap: 0.05, loopPause: 0.9, volume: 0.22, voice: "note", tail: 0.12,
  });

// Chimes — bright bell arpeggio C5 E5 G5 C6
const buildChimes: BuildFn = (ctx, dest) =>
  scheduleMelody(ctx, dest, {
    melody: [523.25, 659.25, 783.99, 1046.5],
    noteDuration: 0.5, noteGap: 0.08, loopPause: 1.2, volume: 0.16, voice: "bell", tail: 0.4,
  });

// Aurora — soft rising melody G4 C5 E5 G5 E5 C5
const buildAurora: BuildFn = (ctx, dest) =>
  scheduleMelody(ctx, dest, {
    melody: [392.0, 523.25, 659.25, 783.99, 659.25, 523.25],
    noteDuration: 0.34, noteGap: 0.1, loopPause: 1.4, volume: 0.18, voice: "note", tail: 0.3,
  });

// Cascade — quick descending run C6 → C5
const buildCascade: BuildFn = (ctx, dest) =>
  scheduleMelody(ctx, dest, {
    melody: [1046.5, 987.77, 880.0, 783.99, 698.46, 659.25, 587.33, 523.25],
    noteDuration: 0.12, noteGap: 0.04, loopPause: 1.0, volume: 0.2, voice: "note", tail: 0.1,
  });

// Pulse — steady rhythmic pulses on G5
const buildPulse: BuildFn = (ctx, dest) =>
  scheduleMelody(ctx, dest, {
    melody: [783.99, 0, 783.99, 0, 783.99, 0],
    noteDuration: 0.14, noteGap: 0.1, loopPause: 0.7, volume: 0.22, voice: "note", tail: 0.18,
  });

// Crystal — high shimmering bells E6 B5 D6
const buildCrystal: BuildFn = (ctx, dest) =>
  scheduleMelody(ctx, dest, {
    melody: [1318.51, 987.77, 1174.66],
    noteDuration: 0.4, noteGap: 0.12, loopPause: 1.3, volume: 0.14, voice: "bell", tail: 0.3,
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SYNTH_BUILDERS: Record<string, BuildFn> = {
  marimba: buildMarimba,
  reflection: buildReflection,
  ripple: buildRipple,
  beacon: buildBeacon,
  chimes: buildChimes,
  aurora: buildAurora,
  cascade: buildCascade,
  pulse: buildPulse,
  crystal: buildCrystal,
};

export function createRingtoneAudio(id?: string): HTMLAudioElement {
  const ringtoneId = id || getRingtonePreference();

  const builder = SYNTH_BUILDERS[ringtoneId];
  if (builder) {
    return createSynthAudio(builder);
  }

  if (ringtoneId === "custom") {
    const dataUrl = getCustomRingtone();
    if (dataUrl) {
      const audio = new Audio(dataUrl);
      audio.loop = true;
      return audio;
    }
    const fallback = new Audio("/ringtone.wav");
    fallback.loop = true;
    return fallback;
  }

  // "classic" / Default / anything else → the classic ring file
  const audio = new Audio("/ringtone.wav");
  audio.loop = true;
  return audio;
}

export function previewRingtone(id: string): () => void {
  const audio = createRingtoneAudio(id);
  audio.play().catch(console.error);

  const timeout = setTimeout(() => {
    audio.pause();
  }, 4000);

  return () => {
    clearTimeout(timeout);
    audio.pause();
  };
}
