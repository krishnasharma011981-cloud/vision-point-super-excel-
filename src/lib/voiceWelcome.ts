const ELEVEN_LABS_WELCOME_AUDIO =
  '/assets/aistudio/ElevenLabs_2026-11-13T18_47_25_Kareena_-_Expressive_Companion_in_Love_pvc_s50_sim75_v4_a46eae0f.mp3';

let lastPlayedAt = 0;
let cachedAudio: HTMLAudioElement | null = null;

function getAudioPlayer(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!cachedAudio) {
    cachedAudio = new Audio(ELEVEN_LABS_WELCOME_AUDIO);
    cachedAudio.preload = 'auto';
  }
  return cachedAudio;
}

export function speakWelcomeMessage(force = false): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (!force && now - lastPlayedAt < 5000) return;
  lastPlayedAt = now;

  const player = getAudioPlayer();
  if (player) {
    try {
      player.currentTime = 0;
      player.volume = 1.0;
      const playPromise = player.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {
          fallbackSpeech();
        });
      }
      return;
    } catch {
      fallbackSpeech();
      return;
    }
  }
  fallbackSpeech();
}

function fallbackSpeech(): void {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance("Welcome to Ashish Pandey's Database Security");
    utterance.rate = 0.95;
    utterance.volume = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Ignore browser speech restrictions
  }
}
