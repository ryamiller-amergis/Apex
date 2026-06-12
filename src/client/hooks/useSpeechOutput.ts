import { useCallback, useEffect, useRef, useState } from 'react';
import { stripMarkdown } from '../utils/stripMarkdown';
import { pickSpeechVoice } from '../utils/pickSpeechVoice';
import { SPEECH_OUTPUT_DEFAULT_RATE } from './useSpeechOutputSettings';

const MAX_CHUNK_LENGTH = 200;

export interface SpeechOutputOptions {
  rate?: number;
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK_LENGTH) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const next = current ? `${current} ${trimmed}` : trimmed;
    if (next.length <= MAX_CHUNK_LENGTH) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);

    if (trimmed.length <= MAX_CHUNK_LENGTH) {
      current = trimmed;
      continue;
    }

    let remaining = trimmed;
    while (remaining.length > MAX_CHUNK_LENGTH) {
      chunks.push(remaining.slice(0, MAX_CHUNK_LENGTH));
      remaining = remaining.slice(MAX_CHUNK_LENGTH);
    }
    current = remaining;
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

function configureUtterance(
  utterance: SpeechSynthesisUtterance,
  voice: SpeechSynthesisVoice | null,
  rate: number,
): void {
  utterance.rate = rate;
  utterance.pitch = 1;
  utterance.volume = 1;
  if (voice) utterance.voice = voice;
}

/**
 * Encapsulates browser text-to-speech via the Web Speech API.
 */
export function useSpeechOutput(options: SpeechOutputOptions = {}): {
  speak: (text: string) => void;
  stop: () => void;
  isSpeaking: boolean;
  isSpeechOutputSupported: boolean;
  selectedVoiceName: string | null;
} {
  const rate = options.rate ?? SPEECH_OUTPUT_DEFAULT_RATE;

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSpeechOutputSupported, setIsSpeechOutputSupported] = useState(false);
  const [selectedVoiceName, setSelectedVoiceName] = useState<string | null>(null);

  const chunkTextsRef = useRef<string[]>([]);
  const activeChunkIndexRef = useRef(0);
  const speakingRef = useRef(false);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const rateRef = useRef(rate);

  const playFromIndexRef = useRef<(startIndex: number) => void>(() => {});

  playFromIndexRef.current = (startIndex: number) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    const chunks = chunkTextsRef.current;
    if (startIndex >= chunks.length) {
      speakingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    window.speechSynthesis.cancel();
    setIsSpeaking(true);

    const playChunk = (index: number) => {
      activeChunkIndexRef.current = index;

      if (index >= chunks.length) {
        speakingRef.current = false;
        setIsSpeaking(false);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      configureUtterance(utterance, voiceRef.current, rateRef.current);

      utterance.onstart = () => {
        setIsSpeaking(true);
      };

      utterance.onend = () => {
        if (index >= chunks.length - 1) {
          speakingRef.current = false;
          setIsSpeaking(false);
          return;
        }
        playChunk(index + 1);
      };

      utterance.onerror = () => {
        speakingRef.current = false;
        setIsSpeaking(false);
      };

      window.speechSynthesis.speak(utterance);
    };

    playChunk(startIndex);
  };

  useEffect(() => {
    rateRef.current = rate;
    if (!speakingRef.current) return;
    playFromIndexRef.current(activeChunkIndexRef.current);
  }, [rate]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const supported = 'speechSynthesis' in window;
    setIsSpeechOutputSupported(supported);
    if (!supported) return;

    const refreshVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const picked = pickSpeechVoice(voices);
      voiceRef.current = picked;
      setSelectedVoiceName(picked?.name ?? null);
    };

    refreshVoice();
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoice);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', refreshVoice);
      window.speechSynthesis.cancel();
    };
  }, []);

  const stop = useCallback(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    chunkTextsRef.current = [];
    activeChunkIndexRef.current = 0;
    speakingRef.current = false;
    setIsSpeaking(false);
  }, []);

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    speakingRef.current = false;
    setIsSpeaking(false);

    const plain = stripMarkdown(text);
    if (!plain) return;

    const chunks = chunkText(plain);
    chunkTextsRef.current = chunks;
    activeChunkIndexRef.current = 0;
    speakingRef.current = true;
    playFromIndexRef.current(0);
  }, []);

  return { speak, stop, isSpeaking, isSpeechOutputSupported, selectedVoiceName };
}
