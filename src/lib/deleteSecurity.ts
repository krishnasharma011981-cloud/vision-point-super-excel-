export const DELETE_SECURITY_PASSWORD = '177177';

export const DELETE_WARNING_AUDIO =
  '/assets/aistudio/cartesia_2026-11-18T08_05_19Z_ASHISH-SSIR_sonic-3.6_hi-IN_speed-1.2_sr-24000_a29a8fa5.wav';

export const DELETE_WARNING_MESSAGE =
  'आखिर चल क्या रहा है। बिना पूछे ये सब क्यों डिलीट कर रहे हो? मुझे अभी जवाब चाहिए।';

export function verifyDeletePassword(input: string): boolean {
  return String(input ?? '').trim() === DELETE_SECURITY_PASSWORD;
}

export interface StaffPermissionSubject {
  uid: string;
  role: 'super_admin' | 'centre_head' | 'employee';
  centreId: string;
}

export function canManageStaffMember(actor: StaffPermissionSubject, target: StaffPermissionSubject): boolean {
  if (actor.role === 'super_admin') return true;
  return actor.role === 'centre_head' && target.role === 'employee' && target.centreId === actor.centreId;
}

export function canDeleteStaffMember(actor: StaffPermissionSubject, target: StaffPermissionSubject): boolean {
  if (!target.uid || target.uid === actor.uid) return false;
  if (target.role === 'super_admin') return false;
  return canManageStaffMember(actor, target);
}

export interface DeleteVoiceCallbacks {
  onPlayStart?: () => void;
  onProgress?: (progress: number) => void;
  onEnded?: () => void;
  onAutoplayBlocked?: () => void;
}

let cachedDeleteAudio: HTMLAudioElement | null = null;
let deleteVoiceFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let activeCallbacks: DeleteVoiceCallbacks = {};
let lastPlayedAtMs = 0;
let isCurrentlySpeaking = false;

function getDeleteAudioPlayer(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!cachedDeleteAudio) {
    cachedDeleteAudio = new Audio(DELETE_WARNING_AUDIO);
    cachedDeleteAudio.preload = 'auto';
  }
  return cachedDeleteAudio;
}

export function setDeleteVoiceCallbacks(callbacks: DeleteVoiceCallbacks): void {
  activeCallbacks = callbacks;
  if (isCurrentlySpeaking) {
    activeCallbacks.onPlayStart?.();
  }
}

export function stopDeleteWarningVoice(): void {
  if (typeof window === 'undefined') return;
  isCurrentlySpeaking = false;
  lastPlayedAtMs = 0;
  if (deleteVoiceFallbackTimer) {
    clearTimeout(deleteVoiceFallbackTimer);
    deleteVoiceFallbackTimer = null;
  }
  if (cachedDeleteAudio) {
    try {
      cachedDeleteAudio.pause();
      cachedDeleteAudio.currentTime = 0;
      cachedDeleteAudio.ontimeupdate = null;
      cachedDeleteAudio.onended = null;
      cachedDeleteAudio.onerror = null;
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

export function playDeleteWarningVoice(
  callbacks?: DeleteVoiceCallbacks,
  options?: { forceRestart?: boolean },
): void {
  if (typeof window === 'undefined') return;
  if (callbacks) {
    activeCallbacks = callbacks;
  }

  const now = Date.now();
  if (!options?.forceRestart && isCurrentlySpeaking && now - lastPlayedAtMs < 600) {
    activeCallbacks.onPlayStart?.();
    return;
  }

  stopDeleteWarningVoice();
  lastPlayedAtMs = now;
  const player = getDeleteAudioPlayer();
  if (!player) {
    fallbackDeleteSpeech();
    return;
  }

  try {
    player.currentTime = 0;
    player.volume = 1.0;

    let finished = false;
    const finishOnce = () => {
      if (finished) return;
      finished = true;
      isCurrentlySpeaking = false;
      if (deleteVoiceFallbackTimer) {
        clearTimeout(deleteVoiceFallbackTimer);
        deleteVoiceFallbackTimer = null;
      }
      activeCallbacks.onProgress?.(100);
      activeCallbacks.onEnded?.();
    };

    player.ontimeupdate = () => {
      const dur = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 4.5;
      const pct = Math.min(99, Math.max(0, Math.round((player.currentTime / dur) * 100)));
      activeCallbacks.onProgress?.(pct);
    };

    player.onended = finishOnce;
    player.onerror = () => {
      if (finished) return;
      fallbackDeleteSpeech();
    };

    isCurrentlySpeaking = true;
    const playPromise = player.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          activeCallbacks.onPlayStart?.();
          const expectedMs =
            Number.isFinite(player.duration) && player.duration > 0
              ? Math.ceil(player.duration * 1000) + 1200
              : 6500;
          deleteVoiceFallbackTimer = setTimeout(finishOnce, expectedMs);
        })
        .catch(() => {
          isCurrentlySpeaking = false;
          if (activeCallbacks.onAutoplayBlocked) {
            activeCallbacks.onAutoplayBlocked();
          } else {
            fallbackDeleteSpeech();
          }
        });
    } else {
      activeCallbacks.onPlayStart?.();
      deleteVoiceFallbackTimer = setTimeout(finishOnce, 6500);
    }
  } catch {
    fallbackDeleteSpeech();
  }
}

function fallbackDeleteSpeech(): void {
  if (!('speechSynthesis' in window)) {
    isCurrentlySpeaking = false;
    activeCallbacks.onProgress?.(100);
    activeCallbacks.onEnded?.();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(DELETE_WARNING_MESSAGE);
    utterance.lang = 'hi-IN';
    utterance.rate = 1.05;
    utterance.volume = 1.0;
    let done = false;
    const finishSpeech = () => {
      if (done) return;
      done = true;
      isCurrentlySpeaking = false;
      if (deleteVoiceFallbackTimer) {
        clearTimeout(deleteVoiceFallbackTimer);
        deleteVoiceFallbackTimer = null;
      }
      activeCallbacks.onProgress?.(100);
      activeCallbacks.onEnded?.();
    };
    isCurrentlySpeaking = true;
    utterance.onstart = () => activeCallbacks.onPlayStart?.();
    utterance.onend = finishSpeech;
    utterance.onerror = finishSpeech;
    deleteVoiceFallbackTimer = setTimeout(finishSpeech, 6000);
    window.speechSynthesis.speak(utterance);
  } catch {
    isCurrentlySpeaking = false;
    activeCallbacks.onProgress?.(100);
    activeCallbacks.onEnded?.();
  }
}
