/** Patterns that usually indicate higher-quality / less robotic voices. */
const PREFERRED_NAME_PATTERNS = [
  /natural/i,
  /neural/i,
  /premium/i,
  /enhanced/i,
  /online/i,
  /google.*english/i,
  /microsoft.*(aria|jenny|guy|sara|zira|andrew|emma)/i,
  /samantha/i,
  /karen/i,
  /daniel/i,
  /moira/i,
  /tessa/i,
  /veena/i,
];

/** Patterns for voices that tend to sound especially synthetic. */
const AVOID_NAME_PATTERNS = [/espeak/i, /festival/i, /pico/i, /android/i, /compact/i];

function scoreVoice(voice: SpeechSynthesisVoice, preferredLang: string): number {
  let score = 0;
  const name = voice.name;

  for (const pattern of PREFERRED_NAME_PATTERNS) {
    if (pattern.test(name)) score += 12;
  }
  for (const pattern of AVOID_NAME_PATTERNS) {
    if (pattern.test(name)) score -= 25;
  }

  if (voice.lang === preferredLang) score += 8;
  else if (voice.lang.startsWith(preferredLang.split('-')[0])) score += 4;

  // Cloud / remote voices are often higher quality in Chromium-based browsers.
  if (voice.localService === false) score += 4;

  if (voice.default) score -= 2;

  return score;
}

/**
 * Picks the most natural-sounding voice available for the user's locale.
 */
export function pickSpeechVoice(
  voices: SpeechSynthesisVoice[],
  preferredLang: string = typeof navigator !== 'undefined' ? navigator.language : 'en-US',
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  const langPrefix = preferredLang.split('-')[0];
  const langMatches = voices.filter(
    (v) => v.lang === preferredLang || v.lang.startsWith(`${langPrefix}-`) || v.lang === langPrefix,
  );
  const pool = langMatches.length > 0 ? langMatches : voices;

  return [...pool].sort((a, b) => scoreVoice(b, preferredLang) - scoreVoice(a, preferredLang))[0] ?? null;
}
