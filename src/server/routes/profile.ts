/**
 * Authenticated profile routes — thin adapter over profileService.
 * Mounted at /api/profile behind ensureAuthenticated (strict Azure AD OID required).
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  getCurrentProfile,
  getProfileCard,
  ProfileNotFoundError,
  ProfileValidationError,
  updateCurrentProfile,
} from '../services/profileService';
import {
  AvatarDependencyError,
  AvatarValidationError,
  deleteOwnAvatar,
  replaceOwnAvatar,
} from '../services/avatarService';
import { buildAvatarCacheHeaders, resolveAvatar } from '../services/avatarResolverService';
import { getDisplayName, getUserEmail } from '../utils/requestUser';
import { fetchCurrentUserOrgProfile } from '../services/graphOrgProfileService';
import {
  AVATAR_MAX_BYTES,
  parseUpdateCurrentProfileRequest,
  type CurrentProfileResponse,
} from '../../shared/types/profile';

const router = Router();

/** Attach best-effort Graph org fields; never fails the profile response. */
async function withOrg(
  req: Request,
  profile: CurrentProfileResponse
): Promise<CurrentProfileResponse> {
  const org = await fetchCurrentUserOrgProfile(req);
  return { ...profile, org };
}

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES },
});

/**
 * Strict subject extraction: require non-empty Azure AD profile.oid.
 * Does not accept the anonymous fallback from getUserId.
 */
export function requireSubjectOid(req: Request): string | null {
  const oid = (req as any).user?.profile?.oid;
  if (typeof oid !== 'string' || oid.trim().length === 0) {
    return null;
  }
  return oid;
}

function claimIdentity(req: Request) {
  return {
    displayName: getDisplayName(req),
    email: getUserEmail(req) ?? '',
  };
}

function sendServiceError(res: Response, err: unknown): void {
  if (err instanceof ProfileValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof ProfileNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  // Do not log personal content (OID, bio, email).
  console.error('[profile] unexpected error');
  res.status(500).json({ error: 'Internal server error' });
}

// Never log oid, blob keys, or file bytes in any avatar error path (DoD-3).
function sendAvatarServiceError(res: Response, err: unknown): void {
  if (err instanceof AvatarValidationError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  if (err instanceof AvatarDependencyError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  console.error('[profile] avatar unexpected error');
  res.status(500).json({ error: 'Internal server error' });
}

// GET /api/profile/current
router.get('/current', async (req: Request, res: Response) => {
  const subjectOid = requireSubjectOid(req);
  if (!subjectOid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const profile = await getCurrentProfile(subjectOid, claimIdentity(req));
    res.status(200).json(await withOrg(req, profile));
  } catch (err) {
    sendServiceError(res, err);
  }
});

// PUT /api/profile/current
router.put('/current', async (req: Request, res: Response) => {
  const subjectOid = requireSubjectOid(req);
  if (!subjectOid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const parsed = parseUpdateCurrentProfileRequest(req.body);
  if (parsed.ok === false) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const profile = await updateCurrentProfile(subjectOid, claimIdentity(req), parsed.value);
    res.status(200).json(await withOrg(req, profile));
  } catch (err) {
    sendServiceError(res, err);
  }
});

// GET /api/profile/users/:oid/card
router.get('/users/:oid/card', async (req: Request, res: Response) => {
  const subjectOid = requireSubjectOid(req);
  if (!subjectOid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const targetOid = req.params.oid ? decodeURIComponent(req.params.oid) : '';
  if (!targetOid.trim()) {
    res.status(400).json({ error: 'User oid is required' });
    return;
  }

  try {
    const card = await getProfileCard(targetOid);
    res.status(200).json(card);
  } catch (err) {
    sendServiceError(res, err);
  }
});

// POST /api/profile/avatar — replace the caller's own avatar. Self-scoped:
// the actor is always the authenticated subjectOid; the multipart body may
// never target another user, so no target id is read from req.body/params.
router.post('/avatar', (req: Request, res: Response) => {
  const subjectOid = requireSubjectOid(req);
  if (!subjectOid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  uploadAvatar.single('avatar')(req, res, async (uploadErr: unknown) => {
    if (uploadErr) {
      if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'Avatar file exceeds the maximum size' });
        return;
      }
      res.status(400).json({ error: 'Invalid avatar upload' });
      return;
    }

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      res.status(400).json({ error: 'Avatar file is required' });
      return;
    }

    let cropInput: unknown;
    try {
      cropInput = typeof req.body?.crop === 'string' ? JSON.parse(req.body.crop) : req.body?.crop;
    } catch {
      res.status(400).json({ error: 'Crop must be valid JSON' });
      return;
    }

    try {
      const result = await replaceOwnAvatar(
        subjectOid,
        file.buffer,
        cropInput,
        claimIdentity(req).displayName
      );
      res.status(200).json(result);
    } catch (err) {
      sendAvatarServiceError(res, err);
    }
  });
});

// DELETE /api/profile/avatar — delete the caller's own avatar. No body is
// read; any target-user fields the client might send are ignored.
router.delete('/avatar', async (req: Request, res: Response) => {
  const subjectOid = requireSubjectOid(req);
  if (!subjectOid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const result = await deleteOwnAvatar(subjectOid, claimIdentity(req).displayName);
    res.status(200).json(result);
  } catch (err) {
    sendAvatarServiceError(res, err);
  }
});

// GET /api/profile/avatar/:userOid — resolve any user's avatar (uploaded
// bytes, Graph bytes, or the initials fallback). Read-only; unlike the
// mutation routes above, the target user id is expected here.
router.get('/avatar/:userOid', async (req: Request, res: Response) => {
  const subjectOid = requireSubjectOid(req);
  if (!subjectOid) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const targetOid = req.params.userOid ? decodeURIComponent(req.params.userOid) : '';
  if (!targetOid.trim()) {
    res.status(400).json({ error: 'User oid is required' });
    return;
  }

  try {
    const result = await resolveAvatar(targetOid);
    if (result.kind === 'bytes') {
      const cacheHeaders = buildAvatarCacheHeaders(result.source, result.cacheVersion);
      res.set('Content-Type', result.contentType);
      res.set('Cache-Control', cacheHeaders['Cache-Control']);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('ETag', cacheHeaders.ETag);
      res.status(200).send(result.bytes);
      return;
    }

    res.set('Cache-Control', 'private, max-age=300');
    res.set('X-Avatar-Fallback', 'initials');
    res.set('X-Avatar-Initials', encodeURIComponent(result.initials));
    res.status(204).end();
  } catch (err) {
    sendAvatarServiceError(res, err);
  }
});

export default router;
