import { z } from 'zod';
import { defineRoute } from '../define-route.ts';
import { contractSchemas } from '../schema-registry.ts';

// The data-access module checks its stored values against this list with
// `satisfies`, because this package cannot import the database layer.
export const profileStatusValues = ['active', 'disabled'] as const;
export const profileStatusSchema = z.enum(profileStatusValues);

export const displayNameMaxLength = 100;
export const emailMaxLength = 254;

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(displayNameMaxLength);
export const emailSchema = z.email().max(emailMaxLength);

export const profileSchema = z
  .strictObject({
    displayName: displayNameSchema,
    email: emailSchema.nullable(),
    status: profileStatusSchema,
  })
  .register(contractSchemas, {
    id: 'Profile',
    description: 'The caller’s own profile. Never includes the subject.',
  });

export const updateProfileBodySchema = z
  .strictObject({
    displayName: displayNameSchema,
    email: emailSchema.nullable().optional(),
  })
  .register(contractSchemas, {
    id: 'UpdateProfileBody',
    description:
      'Replaces both editable fields. An omitted or null email clears it.',
  });

export type ProfileStatus = z.infer<typeof profileStatusSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

const exampleProfile = {
  displayName: 'Ada Example',
  email: 'ada@example.test',
  status: 'active',
} as const;

export const getMe = defineRoute({
  id: 'getMe',
  method: 'get',
  path: '/api/v1/me',
  auth: 'principal',
  summary: 'Read my own profile',
  description:
    'Returns the profile of the authenticated principal. The first call for a new principal creates the profile and still returns 200.',
  responses: {
    200: {
      description: 'The caller’s profile',
      body: profileSchema,
      example: exampleProfile,
    },
  },
});

export const putMe = defineRoute({
  id: 'putMe',
  method: 'put',
  path: '/api/v1/me',
  auth: 'principal',
  summary: 'Update my own profile',
  description:
    'Replaces the display name and email of the authenticated principal. An omitted or null email clears it.',
  request: {
    body: updateProfileBodySchema,
    bodyExample: {
      displayName: exampleProfile.displayName,
      email: exampleProfile.email,
    },
  },
  responses: {
    200: {
      description: 'The updated profile',
      body: profileSchema,
      example: exampleProfile,
    },
  },
});
