import React, { useCallback } from 'react';
import { useSpeechOutput } from '../hooks/useSpeechOutput';
import { useSpeechOutputSettings } from '../hooks/useSpeechOutputSettings';
import styles from './ReadAloudButton.module.css';

interface ReadAloudButtonProps {
  text: string;
  className?: string;
}

const SpeakerIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h2l3-3v10l-3-3H3V6z" />
    <path d="M11 5.5a3.5 3.5 0 010 5" />
    <path d="M12.5 3.5a6 6 0 010 9" />
  </svg>
);

const StopIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </svg>
);

export const ReadAloudButton: React.FC<ReadAloudButtonProps> = ({ text, className }) => {
  const { rate, setRate, minRate, maxRate } = useSpeechOutputSettings();
  const { speak, stop, isSpeaking, isSpeechOutputSupported, selectedVoiceName } = useSpeechOutput({ rate });

  const handleClick = useCallback(() => {
    if (isSpeaking) {
      stop();
      return;
    }
    speak(text);
  }, [isSpeaking, stop, speak, text]);

  const handleRateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRate(parseFloat(e.target.value));
  }, [setRate]);

  if (!isSpeechOutputSupported) return null;

  const speedLabel = `${rate.toFixed(1)}×`;
  const voiceHint = selectedVoiceName ? `Voice: ${selectedVoiceName}` : 'Using system voice';

  return (
    <div className={`${styles.controls} ${className ?? ''}`}>
      <button
        type="button"
        className={`${styles.readAloudBtn} ${isSpeaking ? styles.readAloudBtnActive : ''}`}
        onClick={handleClick}
        aria-label={isSpeaking ? 'Stop reading' : 'Read aloud'}
        title={isSpeaking ? 'Stop reading' : `Read aloud (${voiceHint})`}
      >
        {isSpeaking ? <StopIcon /> : <SpeakerIcon />}
      </button>
      <label className={styles.speedControl} title={voiceHint}>
        <span className={styles.speedLabel}>Speed</span>
        <input
          type="range"
          className={styles.speedSlider}
          min={minRate}
          max={maxRate}
          step={0.1}
          value={rate}
          onChange={handleRateChange}
          aria-label="Speech speed"
        />
        <span className={styles.speedValue} aria-hidden="true">{speedLabel}</span>
      </label>
    </div>
  );
};
