import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import styles from './DiagramTitleEditor.module.css';

const titleSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
});

type TitleFormValues = z.infer<typeof titleSchema>;

export interface DiagramTitleEditorProps {
  title: string;
  onTitleChange: (title: string) => void;
  editable: boolean;
}

export const DiagramTitleEditor: React.FC<DiagramTitleEditorProps> = ({
  title,
  onTitleChange,
  editable,
}) => {
  const {
    register,
    reset,
    trigger,
    formState: { errors },
  } = useForm<TitleFormValues>({
    resolver: zodResolver(titleSchema),
    mode: 'onBlur',
    defaultValues: { title },
  });

  useEffect(() => {
    reset({ title });
  }, [title, reset]);

  const titleField = register('title');

  return (
    <div className={styles.titleField}>
      <label className={styles.titleLabelText} htmlFor="diagram-title-input">
        Title
      </label>
      <input
        id="diagram-title-input"
        className={styles.titleInput}
        aria-label="Diagram title"
        aria-invalid={errors.title ? true : undefined}
        aria-describedby={errors.title ? 'diagram-title-error' : undefined}
        disabled={!editable}
        {...titleField}
        onChange={(event) => {
          void titleField.onChange(event);
          onTitleChange(event.target.value);
        }}
        onBlur={(event) => {
          void titleField.onBlur(event);
          void trigger('title');
        }}
        {...{ 'data-testid': 'diagram-title-input' }}
      />
      {errors.title && (
        <span id="diagram-title-error" className={styles.fieldError} role="alert">
          {errors.title.message}
        </span>
      )}
    </div>
  );
};

export default DiagramTitleEditor;
