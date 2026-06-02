import { Router } from 'express';
import { requireAnyPermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  createComment,
  addReply,
  resolveComment,
  reopenComment,
  getComments,
  getUnresolvedCount,
  deleteComment,
} from '../services/reviewCommentService';
import type { CreateReviewCommentRequest, CreateReviewReplyRequest } from '../../shared/types/reviewComments';

const router = Router();

const validDocumentTypes = new Set(['prd', 'design_doc']);

function permissionForDocType(docType: string): string {
  return docType === 'design_doc' ? 'design-docs:review' : 'prds:review';
}

router.get(
  '/:documentType/:documentId',
  requireAnyPermission('prds:review', 'design-docs:review'),
  async (req, res, next) => {
    try {
      const { documentType, documentId } = req.params;
      if (!validDocumentTypes.has(documentType)) {
        return res.status(400).json({ error: 'Invalid document type' });
      }
      const comments = await getComments(documentId, documentType as 'prd' | 'design_doc');
      res.json(comments);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:documentType/:documentId',
  requireAnyPermission('prds:review', 'design-docs:review'),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { documentType, documentId } = req.params;
      if (!validDocumentTypes.has(documentType)) {
        return res.status(400).json({ error: 'Invalid document type' });
      }
      const { sectionKey, body, selector } = req.body as CreateReviewCommentRequest;
      if (!sectionKey || !body || !selector) {
        return res.status(400).json({ error: 'sectionKey, body, and selector are required' });
      }
      const comment = await createComment(
        documentId,
        documentType as 'prd' | 'design_doc',
        sectionKey,
        userId,
        body,
        selector,
      );
      res.status(201).json(comment);
    } catch (err) {
      next(err);
    }
  },
);

router.post('/:commentId/replies', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { body } = req.body as CreateReviewReplyRequest;
    if (!body) {
      return res.status(400).json({ error: 'body is required' });
    }
    const reply = await addReply(req.params.commentId, userId, body);
    res.status(201).json(reply);
  } catch (err) {
    next(err);
  }
});

router.patch('/:commentId/resolve', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await resolveComment(req.params.commentId, userId);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

router.patch('/:commentId/reopen', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await reopenComment(req.params.commentId, userId);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

router.delete('/:commentId', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await deleteComment(req.params.commentId, userId);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:documentType/:documentId/unresolved-count',
  async (req, res, next) => {
    try {
      const { documentType, documentId } = req.params;
      if (!validDocumentTypes.has(documentType)) {
        return res.status(400).json({ error: 'Invalid document type' });
      }
      const cnt = await getUnresolvedCount(documentId, documentType as 'prd' | 'design_doc');
      res.json({ count: cnt });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
