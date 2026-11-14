const TARGET_SAMPLE_RATE = 16000;

let sharedAudioCtx: AudioContext | null = null;
let nextPlayTime = 0;

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx) {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioCtx = new AudioCtx();
  }
  return sharedAudioCtx;
}

export function isSpeakerUnlocked(): boolean {
  if (typeof window === 'undefined') return false;
  if (!sharedAudioCtx) return false;
  return sharedAudioCtx.state === 'running';
}

export async function unlockSpeaker(): Promise<boolean> {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

export function resetPlaybackBuffer(): void {
  nextPlayTime = 0;
}

export function playWalkieChirp(kind: 'start' | 'end' | 'message'): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';

    if (kind === 'start') {
      osc.frequency.setValueAtTime(860, now);
      osc.frequency.setValueAtTime(1280, now + 0.055);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
    } else if (kind === 'end') {
      osc.frequency.setValueAtTime(1040, now);
      osc.frequency.setValueAtTime(680, now + 0.05);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    } else {
      osc.frequency.setValueAtTime(988, now);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    }
  } catch {
    // Non-critical audio cue
  }
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export function enqueuePcmAudioChunk(
  pcmBase64: string,
  sampleRate = TARGET_SAMPLE_RATE,
): { played: boolean; level: number; unlocked: boolean } {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const int16 = base64ToInt16(pcmBase64);
    if (int16.length === 0) {
      return { played: false, level: 0, unlocked: ctx.state === 'running' };
    }

    const float32 = new Float32Array(int16.length);
    let sumSq = 0;
    for (let i = 0; i < int16.length; i++) {
      const sample = int16[i] / 32768;
      float32[i] = sample;
      sumSq += sample * sample;
    }
    const level = Math.min(1, Math.sqrt(sumSq / int16.length) * 5.5);

    if (ctx.state !== 'running') {
      return { played: false, level, unlocked: false };
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (nextPlayTime < now || nextPlayTime - now > 0.6) {
      nextPlayTime = now + 0.035;
    }
    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;

    return { played: true, level, unlocked: true };
  } catch {
    return { played: false, level: 0, unlocked: false };
  }
}

function downsampleToInt16(input: Float32Array, inputSampleRate: number, outputSampleRate: number): Int16Array {
  if (inputSampleRate === outputSampleRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const result = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0;
    const sample = Math.max(-1, Math.min(1, s0 + (s1 - s0) * frac));
    result[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return result;
}

export async function startMicCapture(
  onChunk: (pcmBase64: string, sampleRate: number, level: number) => void,
): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access is not supported in this browser.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
      throw new Error('Microphone permission denied. Please allow microphone access in your browser to use Walkie-Talkie.');
    }
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      throw new Error('No microphone hardware detected on this device.');
    }
    throw new Error(err instanceof Error ? err.message : 'Unable to start microphone capture.');
  }

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;

  let active = true;
  processor.onaudioprocess = (event) => {
    if (!active) return;
    const input = event.inputBuffer.getChannelData(0);
    let sumSq = 0;
    for (let i = 0; i < input.length; i++) {
      sumSq += input[i] * input[i];
    }
    const level = Math.min(1, Math.sqrt(sumSq / input.length) * 5.5);
    const int16 = downsampleToInt16(input, ctx.sampleRate, TARGET_SAMPLE_RATE);
    const base64 = int16ToBase64(int16);
    onChunk(base64, TARGET_SAMPLE_RATE, level);
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(ctx.destination);

  return () => {
    active = false;
    try {
      processor.disconnect();
      source.disconnect();
      silentGain.disconnect();
    } catch {
      // Ignore disconnect errors during teardown
    }
    stream.getTracks().forEach((track) => track.stop());
  };
}
