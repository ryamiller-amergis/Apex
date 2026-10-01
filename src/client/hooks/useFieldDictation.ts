import { useCallback, useEffect, useRef, useState } from 'react';
import { useSpeechInput } from './useSpeechInput';

interface UseFieldDictationOptions<F extends string> {
  getValue: (field: F) => string;
  setValue: (field: F, text: string) => void;
}

/**
 * Shares one browser speech session across several form fields. Only one field
 * listens at a time: pressing another field's mic stops the current session and
 * starts the new field once recognition has ended.
 */
export function useFieldDictation<F extends string>({ getValue, setValue }: UseFieldDictationOptions<F>) {
  const [activeField, setActiveField] = useState<F | null>(null);
  const activeFieldRef = useRef<F | null>(null);
  const pendingFieldRef = useRef<F | null>(null);
  const getValueRef = useRef(getValue);
  const setValueRef = useRef(setValue);
  getValueRef.current = getValue;
  setValueRef.current = setValue;

  const speech = useSpeechInput((text) => {
    const field = activeFieldRef.current;
    if (field) setValueRef.current(field, text);
  });

  const startField = useCallback((field: F) => {
    activeFieldRef.current = field;
    setActiveField(field);
    speech.toggle(getValueRef.current(field) ?? '');
  }, [speech]);

  const toggleField = useCallback((field: F) => {
    if (speech.isListening) {
      pendingFieldRef.current = activeFieldRef.current === field ? null : field;
      speech.stop();
      return;
    }
    startField(field);
  }, [speech, startField]);

  useEffect(() => {
    if (speech.isListening) return;
    const next = pendingFieldRef.current;
    pendingFieldRef.current = null;
    if (next) {
      startField(next);
      return;
    }
    activeFieldRef.current = null;
    setActiveField(null);
    // Only react to recognition ending; startField identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.isListening]);

  return {
    activeField: speech.isListening ? activeField : null,
    isSupported: speech.isSpeechSupported,
    error: speech.speechError,
    toggleField,
  };
}
