type UiSound = "cart-add" | "order-success";

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioContext) return audioContext;
  if (!window.AudioContext) return null;

  try {
    audioContext = new window.AudioContext();
    return audioContext;
  } catch {
    return null;
  }
}

function playNote(
  context: AudioContext,
  params: { start: number; frequency: number; duration: number; volume: number },
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const end = params.start + params.duration;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(params.frequency, params.start);
  oscillator.frequency.exponentialRampToValueAtTime(params.frequency * 1.012, end);

  gain.gain.setValueAtTime(0.0001, params.start);
  gain.gain.exponentialRampToValueAtTime(params.volume, params.start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(params.start);
  oscillator.stop(end + 0.015);
}

/**
 * Deliberately quiet, file-free feedback for direct user actions. It is safe
 * to call from every supported browser: failed or blocked audio is ignored.
 */
export function prepareUiSound(): AudioContext | null {
  const context = getAudioContext();
  if (!context) return null;

  try {
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }
    return context;
  } catch {
    return null;
  }
}

export function playUiSound(sound: UiSound): void {
  const context = prepareUiSound();
  if (!context) return;

  try {

    const start = context.currentTime + 0.005;
    if (sound === "cart-add") {
      playNote(context, { start, frequency: 523.25, duration: 0.075, volume: 0.027 });
      playNote(context, { start: start + 0.07, frequency: 659.25, duration: 0.09, volume: 0.022 });
      return;
    }

    playNote(context, { start, frequency: 523.25, duration: 0.09, volume: 0.027 });
    playNote(context, { start: start + 0.09, frequency: 659.25, duration: 0.1, volume: 0.03 });
    playNote(context, { start: start + 0.19, frequency: 783.99, duration: 0.14, volume: 0.025 });
  } catch {
    // Audio should never get in the way of a cart or checkout action.
  }
}
