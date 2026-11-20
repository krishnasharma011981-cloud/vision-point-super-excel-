import type { UserAccount } from '../types/domain';

export const DEFAULT_SIR_WELCOME_AUDIO =
  '/assets/aistudio/cartesia_2026-11-15T07_19_16Z_ASHISH-SSIR_sonic-3.6_hi-IN_4315358c.wav';

export const CENTRE_HEAD_WELCOME_VOICES = {
  nancy: {
    audioUrl: '/assets/aistudio/cartesia_2026-11-20T06_33_46Z_ASHISH-SSIR_sonic-3.6_hi-IN_83bd4a3b.wav',
    recipientLabel: 'Nancy Mam',
    fallbackText: 'Hello Nancy Mam, aapka swagat hai. Chaliye aaj ka kaam shuru karte hain.',
  },
  nishu: {
    audioUrl: '/assets/aistudio/cartesia_2026-11-20T06_34_00Z_ASHISH-SSIR_sonic-3.6_hi-IN_d025054a.wav',
    recipientLabel: 'Nishu Mam',
    fallbackText: 'Hello Nishu Mam, aapka swagat hai. Chaliye aaj ka kaam shuru karte hain.',
  },
  ekram: {
    audioUrl: '/assets/aistudio/cartesia_2026-11-20T06_34_21Z_ASHISH-SSIR_sonic-3.6_hi-IN_34f58ef2.wav',
    recipientLabel: 'Ekram Sir',
    fallbackText: 'Hello Ekram Sir, aapka swagat hai. Chaliye aaj ka kaam shuru karte hain.',
  },
  pankaj: {
    audioUrl: '/assets/aistudio/cartesia_2026-11-20T06_34_46Z_ASHISH-SSIR_sonic-3.6_hi-IN_6ae74d4d.wav',
    recipientLabel: 'Pankaj Sir',
    fallbackText: 'Hello Pankaj Sir, aapka swagat hai. Chaliye aaj ka kaam shuru karte hain.',
  },
} as const;

export const SIR_PORTRAIT_PATH = '/assets/aistudio/image_c7733cd1.png';

export type WelcomeUserIdentity = Pick<UserAccount, 'fullName' | 'email' | 'role' | 'centreId'>;

export interface ResolvedWelcomeVoice {
  key: 'nancy' | 'nishu' | 'ekram' | 'pankaj' | 'default';
  audioUrl: string;
  recipientLabel?: string;
  fallbackText: string;
}

/**
 * Resolves the exact personalized Ashish Sir login voice for each Centre Head
 * (Nancy Mam, Nishu Mam, Ekram Sir, Pankaj Sir) and falls back to the standard
 * Database Security welcome voice for Super Admin and other staff.
 */
export function resolveWelcomeVoiceForUser(user?: WelcomeUserIdentity | null): ResolvedWelcomeVoice {
  if (!user || user.role === 'super_admin') {
    return {
      key: 'default',
      audioUrl: DEFAULT_SIR_WELCOME_AUDIO,
      fallbackText:
        'Security database mein aapka swagat hai. Main hoon Ashish Pandey. Chaliye aaj ka kaam shuru karte hain.',
    };
  }

  const nameLower = String(user.fullName || '').trim().toLowerCase();
  const emailLower = String(user.email || '').trim().toLowerCase();
  const combined = `${nameLower} ${emailLower}`;

  if (
    combined.includes('nancy') ||
    (user.role === 'centre_head' && emailLower === 'visionpointcivillines@gmail.com')
  ) {
    return { key: 'nancy', ...CENTRE_HEAD_WELCOME_VOICES.nancy };
  }

  if (combined.includes('nishu')) {
    return { key: 'nishu', ...CENTRE_HEAD_WELCOME_VOICES.nishu };
  }

  if (combined.includes('ekram') || combined.includes('ikram')) {
    return { key: 'ekram', ...CENTRE_HEAD_WELCOME_VOICES.ekram };
  }

  if (combined.includes('pankaj')) {
    return { key: 'pankaj', ...CENTRE_HEAD_WELCOME_VOICES.pankaj };
  }

  return {
    key: 'default',
    audioUrl: DEFAULT_SIR_WELCOME_AUDIO,
    fallbackText:
      'Security database mein aapka swagat hai. Main hoon Ashish Pandey. Chaliye aaj ka kaam shuru karte hain.',
  };
}

let lastPlayedAt = 0;
let activeAudio: HTMLAudioElement | null = null;
const audioCacheByUrl = new Map<string, HTMLAudioElement>();
let fallbackEndTimer: ReturnType<typeof setTimeout> | null = null;

export interface WelcomePlaybackCallbacks {
  onProgress?: (progress: number) => void;
  onEnded?: () => void;
  onAutoplayBlocked?: () => void;
}

function getAudioPlayerForUrl(audioUrl: string): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  let player = audioCacheByUrl.get(audioUrl);
  if (!player) {
    player = new Audio(audioUrl);
    player.preload = 'auto';
    audioCacheByUrl.set(audioUrl, player);
  }
  return player;
}

export function stopWelcomeMessage(): void {
  if (typeof window === 'undefined') return;
  if (fallbackEndTimer) {
    clearTimeout(fallbackEndTimer);
    fallbackEndTimer = null;
  }
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.currentTime = 0;
      activeAudio.ontimeupdate = null;
      activeAudio.onended = null;
      activeAudio.onerror = null;
    } catch {
      // Ignore audio pause errors
    }
    activeAudio = null;
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
  user?: WelcomeUserIdentity | null,
): void {
  if (typeof window === 'undefined') return;
  const callbacks: WelcomePlaybackCallbacks =
    typeof callbacksOrOnEnded === 'function' ? { onEnded: callbacksOrOnEnded } : callbacksOrOnEnded || {};

  const now = Date.now();
  if (!force && now - lastPlayedAt < 5000) return;
  lastPlayedAt = now;

  // Stop any previously playing voice clip cleanly before starting the new user's voice
  stopWelcomeMessage();

  const resolved = resolveWelcomeVoiceForUser(user);
  const player = getAudioPlayerForUrl(resolved.audioUrl);

  if (player) {
    activeAudio = player;
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
        const dur = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 4.2;
        const pct = Math.min(99, Math.max(0, Math.round((player.currentTime / dur) * 100)));
        callbacks.onProgress?.(pct);
      };

      player.onended = finishOnce;
      player.onerror = () => {
        if (finished) return;
        fallbackSpeech(callbacks, resolved.fallbackText);
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
              fallbackSpeech(callbacks, resolved.fallbackText);
            }
          });
      } else {
        fallbackEndTimer = setTimeout(finishOnce, 8000);
      }
      return;
    } catch {
      fallbackSpeech(callbacks, resolved.fallbackText);
      return;
    }
  }
  fallbackSpeech(callbacks, resolved.fallbackText);
}

function fallbackSpeech(callbacks: WelcomePlaybackCallbacks, speechText: string): void {
  if (!('speechSynthesis' in window)) {
    callbacks.onProgress?.(100);
    callbacks.onEnded?.();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(speechText);
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
