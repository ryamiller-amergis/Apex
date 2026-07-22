import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import type {
  OverlayFontFamily,
  OverlayHorizontalAlign,
  OverlayListStyle,
  OverlayTextBox,
  OverlayVerticalAlign,
} from '../../shared/types/pdf';
import type { OverlayFormattingPatch } from '../hooks/useOverlayEditor';
import {
  MAX_OVERLAY_FONT_SIZE,
  MAX_OVERLAY_ROTATION,
  MIN_OVERLAY_FONT_SIZE,
  MIN_OVERLAY_ROTATION,
  OVERLAY_FONT_FAMILIES,
  clampOverlayOpacity,
  isOverlayFontSize,
  normalizeOverlayColor,
  normalizeOverlayRotation,
} from '../hooks/overlayFormatting';
import styles from './OverlayFormatToolbar.module.css';

const linkSchema = z.object({
  url: z
    .string()
    .trim()
    .refine(
      (value) => {
        if (!value) return true;
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'Enter a valid http:// or https:// URL.' }
    ),
  displayText: z.string(),
});

type LinkFormValues = z.infer<typeof linkSchema>;

interface OverlayLinkEditorProps {
  overlay: OverlayTextBox;
  onChange: (patch: OverlayFormattingPatch) => void;
  onValidationChange: (hasError: boolean) => void;
}

export const OverlayLinkEditor: React.FC<OverlayLinkEditorProps> = ({
  overlay,
  onChange,
  onValidationChange,
}) => {
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<LinkFormValues>({
    resolver: zodResolver(linkSchema),
    mode: 'onChange',
    defaultValues: {
      url: overlay.linkUrl ?? '',
      displayText: overlay.linkDisplayText ?? '',
    },
  });
  const currentUrl = useWatch({ control, name: 'url' });

  useEffect(() => {
    reset({
      url: overlay.linkUrl ?? '',
      displayText: overlay.linkDisplayText ?? '',
    });
  }, [overlay.id, overlay.linkDisplayText, overlay.linkUrl, reset]);

  useEffect(() => {
    const result = linkSchema.shape.url.safeParse(currentUrl);
    onValidationChange(!result.success);
  }, [currentUrl, onValidationChange]);

  const applyLink = (values: LinkFormValues) => {
    const url = values.url.trim();
    onChange(
      url
        ? {
            linkUrl: url,
            linkDisplayText: values.displayText.trim() || url,
          }
        : { linkUrl: null, linkDisplayText: null }
    );
    onValidationChange(false);
  };

  return (
    <form className={styles.linkEditor} onSubmit={handleSubmit(applyLink)}>
      <label className={styles.field}>
        <span>Link URL</span>
        <input
          {...register('url')}
          type="url"
          placeholder="https://example.com"
          data-testid="overlay-format-link-url"
          aria-invalid={Boolean(errors.url)}
          aria-describedby={
            errors.url ? 'overlay-format-link-error' : undefined
          }
        />
      </label>
      <label className={styles.field}>
        <span>Display text</span>
        <input
          {...register('displayText')}
          type="text"
          data-testid="overlay-format-link-display"
        />
      </label>
      <button type="submit" className={styles.applyButton}>
        Apply link
      </button>
      {errors.url && (
        <span
          id="overlay-format-link-error"
          className={styles.error}
          data-testid="overlay-format-link-error"
          role="alert"
        >
          {errors.url.message}
        </span>
      )}
    </form>
  );
};

interface OverlayFormatToolbarProps {
  overlay: OverlayTextBox;
  onChange: (patch: OverlayFormattingPatch) => void;
  onReplacementTextFocus?: () => void;
  onReplacementTextChange?: (text: string) => void;
  onReplacementTextBlur?: () => void;
  autoFocusReplacementText?: boolean;
  onValidationChange?: (hasError: boolean) => void;
  orientation?: 'horizontal' | 'vertical';
}

const HORIZONTAL_ALIGNMENTS: OverlayHorizontalAlign[] = [
  'left',
  'center',
  'right',
];
const VERTICAL_ALIGNMENTS: OverlayVerticalAlign[] = ['top', 'middle', 'bottom'];

interface NumberStepperProps {
  value: number;
  min: number;
  max: number;
  testId: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}

const NumberStepper: React.FC<NumberStepperProps> = ({
  value,
  min,
  max,
  testId,
  ariaLabel,
  onChange,
}) => (
  <div className={styles.numberStepper}>
    <button
      type="button"
      className={styles.stepButton}
      aria-label={`Decrease ${ariaLabel}`}
      disabled={value <= min}
      onClick={() => onChange(String(Math.max(min, value - 1)))}
    >
      −
    </button>
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      value={value}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(event) => onChange(event.target.value)}
    />
    <button
      type="button"
      className={styles.stepButton}
      aria-label={`Increase ${ariaLabel}`}
      disabled={value >= max}
      onClick={() => onChange(String(Math.min(max, value + 1)))}
    >
      +
    </button>
  </div>
);

export const OverlayFormatToolbar: React.FC<OverlayFormatToolbarProps> = ({
  overlay,
  onChange,
  onReplacementTextFocus,
  onReplacementTextChange,
  onReplacementTextBlur,
  autoFocusReplacementText = false,
  onValidationChange = () => {},
  orientation = 'horizontal',
}) => {
  const [colorDraft, setColorDraft] = useState<string | null>(null);
  const [colorError, setColorError] = useState('');
  const [coverColorDraft, setCoverColorDraft] = useState<string | null>(null);
  const [coverColorError, setCoverColorError] = useState('');

  const applyColor = () => {
    const normalized = normalizeOverlayColor(colorDraft ?? overlay.color);
    if (!normalized) {
      setColorDraft(null);
      setColorError('Use a six-digit hex color such as #FF0000.');
      return;
    }
    setColorDraft(null);
    setColorError('');
    onChange({ color: normalized });
  };

  const applyCoverColor = () => {
    const normalized = normalizeOverlayColor(
      coverColorDraft ?? overlay.backgroundColor ?? '#FFFFFF'
    );
    if (!normalized) {
      setCoverColorDraft(null);
      setCoverColorError('Use a six-digit hex color such as #FFFFFF.');
      return;
    }
    setCoverColorDraft(null);
    setCoverColorError('');
    onChange({ backgroundColor: normalized });
  };

  const applyFontSize = (value: string) => {
    const size = Number(value);
    if (isOverlayFontSize(size)) onChange({ fontSize: size });
  };

  const applyRotation = (value: string, snapToFifteen: boolean) => {
    const rotation = normalizeOverlayRotation(Number(value), snapToFifteen);
    if (rotation !== null) onChange({ rotation });
  };

  return (
    <div
      className={`${styles.toolbar} ${orientation === 'vertical' ? styles.vertical : ''}`}
      role="toolbar"
      aria-label="Overlay text formatting"
      data-testid="pdf-tools-overlay-format-toolbar"
    >
      <div className={styles.toolbarHeader}>
        <div>
          <span className={styles.eyebrow}>Selected text box</span>
          <strong className={styles.title}>Text formatting</strong>
        </div>
        <span className={styles.autoSaveStatus}>
          Changes save automatically
        </span>
      </div>

      <div className={styles.formatRow}>
        <div className={styles.controlGroup}>
          <label className={`${styles.field} ${styles.fontField}`}>
            <span>Font</span>
            <select
              value={overlay.fontFamily}
              data-testid="overlay-format-font-family"
              onChange={(event) =>
                onChange({
                  fontFamily: event.target.value as OverlayFontFamily,
                })
              }
            >
              {OVERLAY_FONT_FAMILIES.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>

          <div className={styles.field}>
            <span>Size</span>
            <NumberStepper
              min={MIN_OVERLAY_FONT_SIZE}
              max={MAX_OVERLAY_FONT_SIZE}
              value={overlay.fontSize}
              testId="overlay-format-font-size"
              ariaLabel="Font size"
              onChange={applyFontSize}
            />
          </div>

          <button
            type="button"
            className={`${styles.toggle} ${overlay.bold ? styles.active : ''}`}
            aria-label="Bold"
            aria-pressed={overlay.bold}
            data-testid="overlay-format-bold"
            onClick={() => onChange({ bold: !overlay.bold })}
          >
            B
          </button>
          <button
            type="button"
            className={`${styles.toggle} ${overlay.italic ? styles.active : ''}`}
            aria-label="Italic"
            aria-pressed={overlay.italic}
            data-testid="overlay-format-italic"
            onClick={() => onChange({ italic: !overlay.italic })}
          >
            <em>I</em>
          </button>
        </div>

        <div className={styles.controlGroup}>
          <label className={styles.field}>
            <span>Color</span>
            <input
              type="text"
              value={colorDraft ?? overlay.color}
              maxLength={7}
              data-testid="overlay-format-color"
              aria-invalid={Boolean(colorError)}
              onChange={(event) => setColorDraft(event.target.value)}
              onBlur={applyColor}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyColor();
                }
              }}
            />
          </label>

          <div className={styles.labeledControl}>
            <span>Align</span>
            <div
              className={styles.segmented}
              role="group"
              aria-label="Horizontal alignment"
              data-testid="overlay-format-align-h"
            >
              {HORIZONTAL_ALIGNMENTS.map((alignment) => (
                <button
                  key={alignment}
                  type="button"
                  title={`Align ${alignment}`}
                  aria-label={`Align ${alignment}`}
                  aria-pressed={overlay.horizontalAlign === alignment}
                  className={
                    overlay.horizontalAlign === alignment ? styles.active : ''
                  }
                  onClick={() => onChange({ horizontalAlign: alignment })}
                >
                  {alignment[0].toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.controlGroup}>
          <label className={`${styles.field} ${styles.opacityField}`}>
            <span>Opacity · {overlay.opacity}%</span>
            <input
              type="range"
              min={10}
              max={100}
              step={1}
              value={overlay.opacity}
              aria-label={`Opacity ${overlay.opacity}%`}
              data-testid="overlay-format-opacity"
              onChange={(event) =>
                onChange({
                  opacity: clampOverlayOpacity(Number(event.target.value)),
                })
              }
            />
          </label>

          <div className={styles.field}>
            <span>Rotation</span>
            <NumberStepper
              min={MIN_OVERLAY_ROTATION}
              max={MAX_OVERLAY_ROTATION}
              value={overlay.rotation}
              testId="overlay-format-rotation"
              ariaLabel="Rotation"
              onChange={(value) => applyRotation(value, false)}
            />
          </div>
        </div>

        <div className={styles.controlGroup}>
          <div className={styles.labeledControl}>
            <span>Position</span>
            <div
              className={styles.segmented}
              role="group"
              aria-label="Vertical alignment"
              data-testid="overlay-format-align-v"
            >
              {VERTICAL_ALIGNMENTS.map((alignment) => (
                <button
                  key={alignment}
                  type="button"
                  title={`Align ${alignment}`}
                  aria-label={`Align ${alignment}`}
                  aria-pressed={overlay.verticalAlign === alignment}
                  className={
                    overlay.verticalAlign === alignment ? styles.active : ''
                  }
                  onClick={() => onChange({ verticalAlign: alignment })}
                >
                  {alignment[0].toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <label className={styles.field}>
            <span>List</span>
            <select
              value={overlay.listStyle}
              data-testid="overlay-format-list-style"
              onChange={(event) =>
                onChange({ listStyle: event.target.value as OverlayListStyle })
              }
            >
              <option value="none">None</option>
              <option value="bullet">Bullets</option>
              <option value="numbered">Numbered</option>
            </select>
          </label>
        </div>
      </div>

      {overlay.kind === 'replace' && (
        <div className={styles.formatRow}>
          <div className={styles.controlGroup}>
            <label className={styles.field}>
              <span>Replacement text</span>
              <textarea
                className={styles.replacementTextarea}
                value={overlay.text}
                rows={Math.max(
                  2,
                  overlay.text.replace(/\r\n?/g, '\n').split('\n').length
                )}
                aria-label="Replacement text"
                data-testid="overlay-format-replacement-text"
                autoFocus={autoFocusReplacementText}
                onFocus={onReplacementTextFocus}
                onChange={(event) =>
                  onReplacementTextChange?.(
                    event.target.value.replace(/\r\n?/g, '\n')
                  )
                }
                onBlur={onReplacementTextBlur}
              />
            </label>
            <label className={styles.field}>
              <span>Cover color</span>
              <input
                type="text"
                value={coverColorDraft ?? overlay.backgroundColor ?? '#FFFFFF'}
                maxLength={7}
                data-testid="overlay-format-background-color"
                aria-invalid={Boolean(coverColorError)}
                onChange={(event) => setCoverColorDraft(event.target.value)}
                onBlur={applyCoverColor}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyCoverColor();
                  }
                }}
              />
            </label>
          </div>
        </div>
      )}

      <div className={styles.linkRow}>
        <OverlayLinkEditor
          overlay={overlay}
          onChange={onChange}
          onValidationChange={onValidationChange}
        />
      </div>

      {colorError && (
        <span className={styles.error} aria-live="polite">
          {colorError}
        </span>
      )}
      {coverColorError && (
        <span className={styles.error} aria-live="polite">
          {coverColorError}
        </span>
      )}
    </div>
  );
};
