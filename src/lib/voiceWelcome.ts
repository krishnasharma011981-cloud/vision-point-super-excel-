const SIR_WELCOME_AUDIO =
  '/assets/aistudio/cartesia_2026-11-15T07_19_16Z_ASHISH-SSIR_sonic-3.6_hi-IN_4315358c.wav';

export const SIR_PORTRAIT_PATH = '/assets/aistudio/image_c7733cd1.png';

let lastPlayedAt = 0;
let cachedAudio: HTMLAudioElement | null = null;
let fallbackEndTimer: ReturnType<typeof setTimeout> | null = null;

export interface WelcomePlaybackCallbacks {
  onProgress?: (progress: number) => void;
  onEnded?: () => void;
  onAutoplayBlocked?: () => void;
}

function getAudioPlayer(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!cachedAudio) {
    cachedAudio = new Audio(SIR_WELCOME_AUDIO);
    cachedAudio.preload = 'auto';
  }
  return cachedAudio;
}

export function stopWelcomeMessage(): void {
  if (typeof window === 'undefined') return;
  if (fallbackEndTimer) {
    clearTimeout(fallbackEndTimer);
    fallbackEndTimer = null;
  }
  if (cachedAudio) {
    try {
      cachedAudio.pause();
      cachedAudio.currentTime = 0;
      cachedAudio.ontimeupdate = null;
      cachedAudio.onended = null;
      cachedAudio.onerror = null;
    } catch {
      // Ignore audio pause errors
    }
  }
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore speechSynthesis cancel errors
    }
  }
}

export function speakWelcomeMessage(
  force = false,
  callbacksOrOnEnded?: WelcomePlaybackCallbacks | (() => void),
): void {
  if (typeof window === 'undefined') return;
  const callbacks: WelcomePlaybackCallbacks =
    typeof callbacksOrOnEnded === 'function' ? { onEnded: callbacksOrOnEnded } : callbacksOrOnEnded || {};

  const now = Date.now();
  if (!force && now - lastPlayedAt < 5000) return;
  lastPlayedAt = now;

  if (fallbackEndTimer) {
    clearTimeout(fallbackEndTimer);
    fallbackEndTimer = null;
  }

  const player = getAudioPlayer();
  if (player) {
    try {
      player.pause();
      player.currentTime = 0;
      player.volume = 1.0;

      let finished = false;
      const finishOnce = () => {
        if (finished) return;
        finished = true;
        if (fallbackEndTimer) {
          clearTimeout(fallbackEndTimer);
          fallbackEndTimer = null;
        }
        callbacks.onProgress?.(100);
        callbacks.onEnded?.();
      };

      player.ontimeupdate = () => {
        const dur = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 5.6;
        const pct = Math.min(99, Math.max(0, Math.round((player.currentTime / dur) * 100)));
        callbacks.onProgress?.(pct);
      };

      player.onended = finishOnce;
      player.onerror = () => {
        if (finished) return;
        fallbackSpeech(callbacks);
      };

      const playPromise = player.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            const expectedMs =
              Number.isFinite(player.duration) && player.duration > 0 ? Math.ceil(player.duration * 1000) + 1500 : 8000;
            fallbackEndTimer = setTimeout(finishOnce, expectedMs);
          })
          .catch(() => {
            if (callbacks.onAutoplayBlocked) {
              callbacks.onAutoplayBlocked();
            } else {
              fallbackSpeech(callbacks);
            }
          });
      } else {
        fallbackEndTimer = setTimeout(finishOnce, 8000);
      }
      return;
    } catch {
      fallbackSpeech(callbacks);
      return;
    }
  }
  fallbackSpeech(callbacks);
}

function fallbackSpeech(callbacks: WelcomePlaybackCallbacks): void {
  if (!('speechSynthesis' in window)) {
    callbacks.onProgress?.(100);
    callbacks.onEnded?.();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      'Security database mein aapka swagat hai. Main hoon Ashish Pandey. Chaliye aaj ka kaam shuru karte hain.',
    );
    utterance.lang = 'hi-IN';
    utterance.rate = 0.95;
    utterance.volume = 1.0;
    let done = false;
    const finishSpeech = () => {
      if (done) return;
      done = true;
      if (fallbackEndTimer) {
        clearTimeout(fallbackEndTimer);
        fallbackEndTimer = null;
      }
      callbacks.onProgress?.(100);
      callbacks.onEnded?.();
    };
    utterance.onend = finishSpeech;
    utterance.onerror = finishSpeech;
    fallbackEndTimer = setTimeout(finishSpeech, 7000);
    window.speechSynthesis.speak(utterance);
  } catch {
    callbacks.onProgress?.(100);
    callbacks.onEnded?.();
  }
}
