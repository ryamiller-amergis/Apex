import { Router, Request, Response } from 'express';
import { AzureDevOpsService } from '../services/azureDevOps';
import { getWikiPage } from '../services/wikiCatalog';

const router = Router();

interface WorkItemSpec {
  type: 'Epic' | 'Feature' | 'Product Backlog Item' | 'Task' | 'Bug';
  title: string;
  description?: string;
  parentTitle?: string;
  /** Local backlog item IDs (e.g. "WI-001") that must complete before this item */
  predecessors?: string[];
  tags?: string[];
}

interface FromPrdRequest {
  project: string;
  areaPath?: string;
  wikiId: string;
  wikiPagePath: string;
  items: WorkItemSpec[];
}

/**
 * POST /api/workitems/from-prd
 * Create ADO work items from a structured list produced by the sdls-backlog skill.
 * Also links each item back to the PRD wiki page via a hyperlink relation.
 */
router.post('/from-prd', async (req: Request, res: Response) => {
  const body = req.body as Partial<FromPrdRequest>;

  if (!body.project) return res.status(400).json({ error: 'project is required' });
  if (!body.wikiId) return res.status(400).json({ error: 'wikiId is required' });
  if (!body.wikiPagePath) return res.status(400).json({ error: 'wikiPagePath is required' });
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  try {
    // Fetch the wiki page to get its remote URL for linking
    let prdUrl: string | undefined;
    try {
      const page = await getWikiPage(body.project, body.wikiId, body.wikiPagePath, false);
      prdUrl = page.remoteUrl ?? page.url;
    } catch {
      // Non-fatal: proceed without the link
    }

    const adoService = new AzureDevOpsService(body.project, body.areaPath);
    const created: { title: string; id: number; url: string }[] = [];

    // Title → ADO ID and local backlog ID → ADO ID (for parent/predecessor linking)
    const titleToId = new Map<string, number>();
    const localIdToAdoId = new Map<string, number>();

    for (const spec of body.items) {
      const parentId = spec.parentTitle ? titleToId.get(spec.parentTitle) : undefined;

      const predecessorIds = spec.predecessors
        ?.map((localId) => localIdToAdoId.get(localId))
        .filter((id): id is number => id !== undefined);

      const wi = await adoService.createWorkItemForPrd({
        type: spec.type,
        title: spec.title,
        description: spec.description,
        parentId,
        predecessorIds,
        prdUrl,
        tags: spec.tags,
      });

      titleToId.set(spec.title, wi.id);
      // Map local IDs (e.g. "WI-001") if the spec carries one via tags or a convention
      if (spec.tags) {
        for (const tag of spec.tags) {
          if (/^WI-\d+$/i.test(tag)) localIdToAdoId.set(tag.toUpperCase(), wi.id);
        }
      }
      created.push({ title: spec.title, id: wi.id, url: wi.url });
    }

    res.status(201).json({ created });
  } catch (err: any) {
    console.error('[workitems/from-prd] error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to create work items' });
  }
});

export default router;
