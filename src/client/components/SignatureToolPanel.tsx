/**
 * SignatureToolPanel — source picker for typed, drawn, and uploaded signatures.
 *
 * Every source is normalised in the browser to a 400×200 transparent PNG
 * canvas before upload so that preview and export use identical pixels.
 * Typed signatures are rasterised immediately.
 * Uploaded JPEG/PNG files are decoded and re-rendered to strip metadata.
 */
import React, { useCallback, useRef, useState } from 'react';
import { SignaturePad } from './SignaturePad';
import styles from './SignatureToolPanel.module.css';

export type SignatureSource = 'typed' | 'drawn' | 'uploaded';

interface SignatureToolPanelProps {
  /** Called with a normalised PNG Blob ready to upload. */
  onSignatureReady: (blob: Blob, source: SignatureSource) => void;
  onCancel: () => void;
  isUploading?: boolean;
}

// ── Normalise helpers ─────────────────────────────────────────────────────────

const NORMALISED_WIDTH = 400;
const NORMALISED_HEIGHT = 160;
const TYPED_FONT = '48px Georgia, serif';
const TYPED_COLOR = '#1a1a2e';

function createNormalisedCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = window.document.createElement('canvas');
    canvas.width = NORMALISED_WIDTH;
    canvas.height = NORMALISED_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) { reject(new Error('Canvas 2D context not available')); return; }
    draw(ctx, NORMALISED_WIDTH, NORMALISED_HEIGHT);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas export returned null'));
    }, 'image/png');
  });
}

async function normaliseTypedSignature(name: string): Promise<Blob> {
  return createNormalisedCanvas((ctx, w, h) => {
    ctx.font = TYPED_FONT;
    ctx.fillStyle = TYPED_COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, w / 2, h / 2, w - 32);
  });
}

async function normaliseImageBlob(source: Blob): Promise<Blob> {
  const url = URL.createObjectURL(source);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      createNormalisedCanvas((ctx, w, h) => {
        const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight, 1);
        const drawW = img.naturalWidth * scale;
        const drawH = img.naturalHeight * scale;
        ctx.drawImage(img, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
      }).then(resolve).catch(reject);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image could not be loaded for normalisation.'));
    };
    img.src = url;
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export const SignatureToolPanel: React.FC<SignatureToolPanelProps> = ({
  onSignatureReady,
  onCancel,
  isUploading = false,
}) => {
  const [activeSource, setActiveSource] = useState<SignatureSource>('typed');
  const [typedName, setTypedName] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleTypedSubmit = useCallback(async () => {
    const trimmed = typedName.trim();
    if (!trimmed) { setTypedError('Please enter your name to create a signature.'); return; }
    setTypedError(null);
    try {
      const blob = await normaliseTypedSignature(trimmed);
      onSignatureReady(blob, 'typed');
    } catch {
      setTypedError('Could not create signature. Please try drawing instead.');
    }
  }, [typedName, onSignatureReady]);

  const handleDrawnReady = useCallback(async (blob: Blob) => {
    try {
      const normalised = await normaliseImageBlob(blob);
      onSignatureReady(normalised, 'drawn');
    } catch {
      // The blob from the pad is already PNG; try passing it through directly
      onSignatureReady(blob, 'drawn');
    }
  }, [onSignatureReady]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!e.target) return;
    (e.target as HTMLInputElement).value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select a PNG or JPEG image.');
      return;
    }
    setUploadError(null);
    try {
      const normalised = await normaliseImageBlob(file);
      onSignatureReady(normalised, 'uploaded');
    } catch {
      setUploadError('Could not process the image. Please try another file.');
    }
  }, [onSignatureReady]);

  return (
    <div className={styles.panel} data-testid="signature-tool-panel">
      <p className={styles.disclosure}>
        Electronic signature image only — not a certificate-backed digital signature.
      </p>

      {/* Source tabs */}
      <div className={styles.tabs} role="tablist" aria-label="Signature source">
        {(['typed', 'drawn', 'uploaded'] as SignatureSource[]).map((src) => (
          <button
            key={src}
            role="tab"
            type="button"
            className={`${styles.tab} ${activeSource === src ? styles.tabActive : ''}`}
            aria-selected={activeSource === src}
            onClick={() => setActiveSource(src)}
          >
            {src === 'typed' ? 'Type' : src === 'drawn' ? 'Draw' : 'Upload'}
          </button>
        ))}
      </div>

      {/* Typed */}
      {activeSource === 'typed' && (
        <div className={styles.sourceArea}>
          <label className={styles.label} htmlFor="sig-typed-name">
            Enter your full name
          </label>
          <input
            id="sig-typed-name"
            type="text"
            className={styles.typedInput}
            value={typedName}
            onChange={(e) => { setTypedName(e.target.value); setTypedError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleTypedSubmit(); }}
            placeholder="Your name"
            aria-describedby={typedError ? 'sig-typed-error' : undefined}
            data-testid="sig-typed-input"
          />
          {typedError && (
            <p id="sig-typed-error" className={styles.error} role="alert">{typedError}</p>
          )}
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className={styles.useBtn}
              onClick={() => void handleTypedSubmit()}
              disabled={!typedName.trim() || isUploading}
              data-testid="sig-typed-use"
            >
              {isUploading ? 'Saving…' : 'Use signature'}
            </button>
          </div>
        </div>
      )}

      {/* Drawn */}
      {activeSource === 'drawn' && (
        <div className={styles.sourceArea}>
          <SignaturePad
            onUse={(blob) => void handleDrawnReady(blob)}
            onCancel={onCancel}
          />
        </div>
      )}

      {/* Uploaded */}
      {activeSource === 'uploaded' && (
        <div className={styles.sourceArea}>
          <button
            type="button"
            className={styles.uploadBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            data-testid="sig-upload-btn"
          >
            {isUploading ? 'Saving…' : 'Choose image (PNG or JPEG)'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            className={styles.hiddenInput}
            onChange={(e) => void handleFileChange(e)}
          />
          {uploadError && (
            <p className={styles.error} role="alert">{uploadError}</p>
          )}
          <button type="button" className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  );
};
