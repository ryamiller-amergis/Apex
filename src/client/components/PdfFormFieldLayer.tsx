import React, { useCallback } from 'react';
import type { PdfTextFormFieldDefinition, PdfTextFormValue } from '../../shared/types/pdf';
import type { FormFieldGeometry } from '../utils/pdfFormFields';
import { getFieldValue, setFieldValue } from '../utils/pdfFormFields';
import styles from './PdfFormFieldLayer.module.css';

interface PdfFormFieldLayerProps {
  /** The source-file ID — included in persisted values for disambiguation. */
  fileId: string;
  /** Resolved field geometry in percentage units, derived from PDF.js annotations. */
  fields: FormFieldGeometry[];
  /** Server field catalog for this page's source file. */
  catalog: PdfTextFormFieldDefinition[];
  /** Currently persisted values (from session). */
  values: PdfTextFormValue[];
  /** True when the session is expired or read-only. */
  readOnly?: boolean;
  /** True when rendering saved values in the normal page preview. */
  displayOnly?: boolean;
  /** Called whenever a field value changes — drives debounced autosave. */
  onValuesChange: (updated: PdfTextFormValue[]) => void;
}

/**
 * Renders accessible text inputs / textareas over the PDF page at the
 * exact positions reported by PDF.js widget annotations.
 *
 * Geometry is supplied as percentage values so this layer is resolution-
 * independent and works at any zoom level.
 */
export const PdfFormFieldLayer: React.FC<PdfFormFieldLayerProps> = ({
  fileId,
  fields,
  catalog: _catalog,
  values,
  readOnly = false,
  displayOnly = false,
  onValuesChange,
}) => {
  const handleChange = useCallback(
    (fieldName: string, value: string) => {
      onValuesChange(setFieldValue(values, fileId, fieldName, value));
    },
    [fileId, onValuesChange, values]
  );

  if (fields.length === 0) {
    return null;
  }

  return (
    <div
      className={`${styles.layer} ${displayOnly ? styles.layerDisplayOnly : ''}`}
      aria-label="Form fields"
    >
      {fields.map((field) => {
        const currentValue = getFieldValue(values, fileId, field.fieldName);
        const fieldId = `pdf-form-field-${fileId}-${field.fieldName}`;

        return (
          <div
            key={field.fieldName}
            className={`${styles.fieldWrapper} ${displayOnly ? styles.fieldWrapperDisplayOnly : ''}`}
            style={{
              left: `${field.xPct}%`,
              top: `${field.yPct}%`,
              width: `${field.widthPct}%`,
              height: `${field.heightPct}%`,
            }}
          >
            {field.multiline ? (
              <textarea
                id={fieldId}
                className={`${styles.field} ${displayOnly ? styles.fieldDisplayOnly : ''}`}
                value={currentValue}
                readOnly={readOnly}
                tabIndex={displayOnly ? -1 : undefined}
                aria-label={field.fieldName}
                aria-multiline="true"
                maxLength={field.maxLength ?? undefined}
                onChange={(e) => handleChange(field.fieldName, e.target.value)}
                data-testid={`pdf-form-field-${field.fieldName}`}
              />
            ) : (
              <input
                id={fieldId}
                type="text"
                className={`${styles.field} ${displayOnly ? styles.fieldDisplayOnly : ''}`}
                value={currentValue}
                readOnly={readOnly}
                tabIndex={displayOnly ? -1 : undefined}
                aria-label={field.fieldName}
                maxLength={field.maxLength ?? undefined}
                onChange={(e) => handleChange(field.fieldName, e.target.value)}
                data-testid={`pdf-form-field-${field.fieldName}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Guidance shown in the tool panel when a page has no supported text fields.
 */
export const NoFormFieldsGuidance: React.FC = () => (
  <div className={styles.noFields} role="status">
    No fillable text fields were found on this page.
    Use <strong>Add text</strong> to annotate flat or unsupported forms.
  </div>
);
