/**
 * Tiny WebAudio chimes - no audio assets, just oscillator beeps.
 *
 * Browsers only allow audio after a user gesture; the AudioContext is
 * created lazily and resumed on demand, so the first chime after a fresh
 * page load may be silent if no click happened yet (fine - there is
 * nothing to nudge a player about before they have interacted).
 */
const MUTE_KEY = "spl-muted";

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // private mode etc. - sounds just stay on for the session
  }
}

let audio: AudioContext | undefined;

function context(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return undefined;
  }
}

/** One soft sine note, `at` seconds from now. */
function note(a: AudioContext, freq: number, at: number, duration: number, peak = 0.05): void {
  const t0 = a.currentTime + at;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0005, t0 + duration);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/** Two rising notes: "it's your turn". */
export function turnChime(): void {
  if (isMuted()) return;
  const a = context();
  if (!a) return;
  note(a, 660, 0, 0.15);
  note(a, 880, 0.14, 0.25);
}

/** Three urgent pips: "your clock is at 15 seconds". */
export function clockChime(): void {
  if (isMuted()) return;
  const a = context();
  if (!a) return;
  note(a, 520, 0, 0.09, 0.06);
  note(a, 520, 0.14, 0.09, 0.06);
  note(a, 392, 0.28, 0.2, 0.06);
}
