/**
 * Autosave hook for AcroForm text-field values.
 * Follows the same 500 ms debounce + flush-on-demand pattern as
 * useOverlayAutosave, using the PUT /api/pdf/sessions/:id/form-values endpoint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PdfTextFormValue } from '../../shared/types/pdf';
import { useUpdateFormValues } from './usePdfSession';

export const FORM_AUTOSAVE_DELAY_MS = 500;

export type FormSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface UsePdfFormAutosaveOptions {
  sessionId: string | null;
  userId?: string;
  values: PdfTextFormValue[];
  isDirty: boolean;
  onSaved: (values: PdfTextFormValue[]) => void;
}

export function usePdfFormAutosave({
  sessionId,
  userId = '',
  values,
  isDirty,
  onSaved,
}: UsePdfFormAutosaveOptions) {
  const updateFormValues = useUpdateFormValues(userId);
  const valuesKey = JSON.stringify(values);

  const [saveState, setSaveState] = useState<{
    sessionId: string | null;
    status: Exclude<FormSaveStatus, 'dirty'>;
    errorMessage: string | null;
    syncedKey: string | null;
  }>({
    sessionId,
    status: 'idle',
    errorMessage: null,
    syncedKey: null,
  });

  const timerRef = useRef<number | null>(null);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const latestRef = useRef(values);
  const latestKeyRef = useRef(valuesKey);
  const dirtyRef = useRef(isDirty);
  const sessionIdRef = useRef(sessionId);
  const onSavedRef = useRef(onSaved);
  const mutateAsyncRef = useRef(updateFormValues.mutateAsync);

  useEffect(() => {
    latestRef.current = values;
    latestKeyRef.current = valuesKey;
    dirtyRef.current = isDirty;
    sessionIdRef.current = sessionId;
    onSavedRef.current = onSaved;
    mutateAsyncRef.current = updateFormValues.mutateAsync;
  }, [isDirty, onSaved, sessionId, updateFormValues.mutateAsync, values, valuesKey]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flushNow = useCallback((): Promise<void> => {
    clearTimer();

    if (flushPromiseRef.current) return flushPromiseRef.current;

    const run = async () => {
      while (dirtyRef.current) {
        const activeSessionId = sessionIdRef.current;
        if (!activeSessionId) return;

        const sentValues = [...latestRef.current];
        const sentKey = latestKeyRef.current;
        setSaveState({
          sessionId: activeSessionId,
          status: 'saving',
          errorMessage: null,
          syncedKey: null,
        });

        try {
          const result = await mutateAsyncRef.current({
            sessionId: activeSessionId,
            values: sentValues,
          });

          if (sessionIdRef.current !== activeSessionId) continue;

          if (latestKeyRef.current === sentKey) {
            dirtyRef.current = false;
            onSavedRef.current(result.values);
            setSaveState({
              sessionId: activeSessionId,
              status: 'saved',
              errorMessage: null,
              syncedKey: sentKey,
            });
            return;
          }
          // Values changed while request was in flight — re-save
        } catch (error) {
          setSaveState({
            sessionId: activeSessionId,
            status: 'error',
            errorMessage:
              error instanceof Error ? error.message : 'Form save failed.',
            syncedKey: null,
          });
          throw error;
        }
      }
    };

    const promise = run().finally(() => {
      if (flushPromiseRef.current === promise) {
        flushPromiseRef.current = null;
      }
    });
    flushPromiseRef.current = promise;
    return promise;
  }, [clearTimer]);

  useEffect(() => {
    clearTimer();
    if (!isDirty || !sessionId) return;

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushNow().catch(() => {
        // Status retained; user can retry
      });
    }, FORM_AUTOSAVE_DELAY_MS);

    return clearTimer;
  }, [clearTimer, flushNow, isDirty, sessionId, valuesKey]);

  useEffect(() => clearTimer, [clearTimer]);

  const stateForSession =
    saveState.sessionId === sessionId
      ? saveState
      : { status: 'idle' as const, errorMessage: null, syncedKey: null };

  const status: FormSaveStatus =
    isDirty &&
    stateForSession.syncedKey !== valuesKey &&
    (stateForSession.status === 'idle' || stateForSession.status === 'saved')
      ? 'dirty'
      : stateForSession.status;

  return {
    status,
    errorMessage: stateForSession.errorMessage,
    flushNow,
    retry: flushNow,
  };
}
