import { zodResolver } from '@hookform/resolvers/zod';
import type { Profile, UpdateProfileBody } from '@project-scope/contracts';
import { updateProfileBodySchema } from '@project-scope/contracts';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { useEffect, useRef, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../../api/ApiError';
import {
  firstProfileField,
  mapProblemToFormErrors,
} from './mapProblemToFormErrors';
import { profileTestIds } from './profileTestIds';
import { useUpdateProfileMutation } from './useUpdateProfileMutation';

const SAVE_ERROR_ID = 'profile-save-error-text';
const SAVE_FAILURE =
  "We couldn't save your changes. Your entries are still here.";
const SIGN_IN_SAVE = 'Sign in to save your profile.';

interface ProfileFormInput {
  displayName: string;
  email: string;
}

type FormAlert = { kind: 'retry' | 'sign-in'; message: string };

export const ProfileForm: React.FC<{ profile: Profile }> = ({ profile }) => {
  const navigate = useNavigate();
  const mutation = useUpdateProfileMutation();
  const alertRef = useRef<HTMLDivElement>(null);
  const [formAlert, setFormAlert] = useState<FormAlert | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<ProfileFormInput, unknown, UpdateProfileBody>({
    resolver: zodResolver(updateProfileBodySchema) as Resolver<
      ProfileFormInput,
      unknown,
      UpdateProfileBody
    >,
    defaultValues: {
      displayName: profile.displayName,
      email: profile.email ?? '',
    },
    mode: 'onChange',
    shouldFocusError: true,
  });

  useEffect(() => {
    if (formAlert) {
      alertRef.current?.focus();
    }
  }, [formAlert]);

  const pending = mutation.isPending;
  const displayNameField = register('displayName');
  const emailField = register('email');

  const applySaveError = (error: unknown) => {
    if (error instanceof ApiError && error.isUnauthenticated) {
      setFormAlert({ kind: 'sign-in', message: SIGN_IN_SAVE });
      return;
    }
    if (error instanceof ApiError && error.kind === 'problem') {
      const mapped = mapProblemToFormErrors(error.problem);
      const focus = firstProfileField(mapped);
      if (mapped.length > 0 && focus) {
        setFormAlert(null);
        for (const field of mapped) {
          setError(field.field, { type: 'server', message: field.message });
        }
        setFocus(focus);
        return;
      }
    }
    setFormAlert({ kind: 'retry', message: SAVE_FAILURE });
  };

  const onValid = (values: UpdateProfileBody) => {
    if (pending) {
      return;
    }
    setFormAlert(null);
    mutation.mutate(
      {
        displayName: values.displayName,
        email: values.email ?? null,
      },
      {
        onSuccess: () => {
          navigate('/profile', { state: { saved: true } });
        },
        onError: (error: unknown) => {
          applySaveError(error);
        },
      }
    );
  };

  const retrySave = () => {
    void handleSubmit(onValid)();
  };

  return (
    <Box
      component="form"
      noValidate
      data-testid={profileTestIds.form}
      aria-describedby={formAlert ? SAVE_ERROR_ID : undefined}
      onSubmit={handleSubmit(onValid)}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxWidth: 480,
      }}
    >
      {formAlert ? (
        <Alert
          severity="error"
          id={SAVE_ERROR_ID}
          role="alert"
          tabIndex={-1}
          ref={alertRef}
          data-testid={profileTestIds.saveError}
          action={
            formAlert.kind === 'retry' ? (
              <Button
                type="button"
                color="inherit"
                onClick={retrySave}
                data-testid={profileTestIds.saveRetry}
              >
                Try again
              </Button>
            ) : undefined
          }
        >
          {formAlert.message}
        </Alert>
      ) : null}
      <TextField
        label="Display name"
        required
        fullWidth
        error={Boolean(errors.displayName)}
        helperText={errors.displayName?.message}
        name={displayNameField.name}
        onBlur={displayNameField.onBlur}
        onChange={displayNameField.onChange}
        inputRef={displayNameField.ref}
        slotProps={{
          htmlInput: { 'data-testid': profileTestIds.displayNameInput },
          formHelperText: errors.displayName ? { role: 'alert' } : undefined,
        }}
      />
      <TextField
        label="Email"
        type="email"
        fullWidth
        error={Boolean(errors.email)}
        helperText={errors.email?.message}
        name={emailField.name}
        onBlur={emailField.onBlur}
        onChange={emailField.onChange}
        inputRef={emailField.ref}
        slotProps={{
          htmlInput: { 'data-testid': profileTestIds.emailInput },
          formHelperText: errors.email ? { role: 'alert' } : undefined,
        }}
      />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button
          type="submit"
          variant="contained"
          aria-disabled={pending ? true : undefined}
          data-testid={profileTestIds.saveButton}
          onClick={(event) => {
            if (pending) {
              event.preventDefault();
            }
          }}
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          component={Link}
          to="/profile"
          data-testid={profileTestIds.cancelButton}
        >
          Cancel
        </Button>
      </Box>
    </Box>
  );
};
