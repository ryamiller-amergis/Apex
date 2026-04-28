import React, { useState, useEffect } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import type { UseFieldArrayAppend, UseFieldArrayRemove, FieldArrayWithId, Control, UseFormRegister, FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BacklogNode,
  BacklogDocumentPayload,
  BacklogEpic,
  BacklogFeature,
  BacklogPBI,
} from '../types/workitem';
import './BacklogDetailsPanel.css';
import BeginDevKickoffModal from './BeginDevKickoffModal';
import { generateBacklogId } from '../../shared/utils/backlogId';
import { UiMockSection } from './UiMockSection';

interface GeneratedPBIData {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: string;
  confidence: string;
  tags: string[];
}

interface GeneratedFeatureData {
  title: string;
  description: string;
  priority: string;
  confidence: string;
  tags: string[];
  clarificationNeeded?: string;
}

interface GeneratedFeatureWithPBIs {
  feature: GeneratedFeatureData;
  pbis: GeneratedPBIData[];
}

/* ── Zod schema for the edit form ────────────────────────────── */

const editSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  status: z.string(),
  description: z.string().optional(),
  priority: z.string().optional(),
  confidence: z.string().optional(),
  tags: z.string().optional(),
  sourceEvidence: z.string().optional(),
  clarificationNeeded: z.string().optional(),
  acceptanceCriteria: z.array(z.object({ value: z.string() })).optional(),
  featureFlag: z
    .object({
      enabled: z.boolean(),
      name: z.string().optional(),
    })
    .optional(),
});

type EditFormValues = z.infer<typeof editSchema>;

/* ── Helpers ─────────────────────────────────────────────────── */

function nodeToFormValues(node: BacklogNode): EditFormValues {
  const n = node as any;
  const pbi = node.workItemType === 'PBI' ? (node as BacklogPBI) : null;
  const feature = node.workItemType === 'Feature' ? (node as BacklogFeature) : null;

  return {
    title: node.title,
    status: node.status ?? 'Draft',
    description: n.description ?? '',
    priority: n.priority ?? '',
    confidence: n.confidence ?? '',
    tags: Array.isArray(n.tags) ? n.tags.join(', ') : '',
    sourceEvidence: n.sourceEvidence ?? '',
    clarificationNeeded: n.clarificationNeeded ?? '',
    acceptanceCriteria: pbi?.acceptanceCriteria?.map(v => ({ value: v })) ?? [],
    featureFlag: feature
      ? { enabled: feature.featureFlag?.enabled ?? false, name: feature.featureFlag?.name ?? '' }
      : undefined,
  };
}

function formValuesToNode(values: EditFormValues, original: BacklogNode): BacklogNode {
  const tags = values.tags
    ? values.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  const base = {
    ...original,
    title: values.title,
    status: values.status,
    description: values.description || undefined,
    priority: values.priority || undefined,
    confidence: values.confidence || undefined,
    tags: tags.length > 0 ? tags : undefined,
    sourceEvidence: values.sourceEvidence || undefined,
    clarificationNeeded: values.clarificationNeeded || undefined,
  };

  if (original.workItemType === 'PBI') {
    const ac = values.acceptanceCriteria
      ?.map(item => item.value)
      .filter(Boolean) ?? [];
    return { ...base, acceptanceCriteria: ac.length > 0 ? ac : undefined } as BacklogPBI;
  }

  if (original.workItemType === 'Feature') {
    const ff = values.featureFlag;
    return {
      ...base,
      featureFlag: ff ? { enabled: ff.enabled, name: ff.name || undefined } : undefined,
    } as BacklogFeature;
  }

  return base as BacklogNode;
}

function buildUpdatedPayload(
  updatedNode: BacklogNode,
  payload: BacklogDocumentPayload
): BacklogDocumentPayload {
  if (updatedNode.workItemType === 'Epic') {
    return {
      ...payload,
      epics: payload.epics.map(e => (e.id === updatedNode.id ? (updatedNode as any) : e)),
    };
  }
  if (updatedNode.workItemType === 'Feature') {
    return {
      ...payload,
      features: payload.features.map(f => (f.id === updatedNode.id ? (updatedNode as any) : f)),
    };
  }
  return {
    ...payload,
    pbis: payload.pbis.map(p => (p.id === updatedNode.id ? (updatedNode as any) : p)),
  };
}

async function saveDraftDoc(
  pagePath: string,
  document: BacklogDocumentPayload,
  project: string,
  areaPath: string
) {
  const res = await fetch('/api/backlog/drafts', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pagePath, document, project, areaPath }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Save failed: ${res.status}`);
  }
  return res.json();
}

function buildBreadcrumb(
  node: BacklogNode,
  document: BacklogDocumentPayload
): BacklogNode[] {
  const crumbs: BacklogNode[] = [];
  if (node.workItemType === 'PBI') {
    const pbi = node as BacklogPBI;
    const feature = document.features.find(f => f.id === pbi.parentId);
    if (feature) {
      const epic = document.epics.find(e => e.id === feature.parentId);
      if (epic) crumbs.push(epic);
      crumbs.push(feature);
    }
  } else if (node.workItemType === 'Feature') {
    const feature = node as BacklogFeature;
    const epic = document.epics.find(e => e.id === feature.parentId);
    if (epic) crumbs.push(epic);
  }
  crumbs.push(node);
  return crumbs;
}

function getParentNode(
  node: BacklogNode,
  document: BacklogDocumentPayload
): BacklogNode | null {
  if (node.workItemType === 'PBI') {
    return document.features.find(f => f.id === (node as BacklogPBI).parentId) ?? null;
  }
  if (node.workItemType === 'Feature') {
    return document.epics.find(e => e.id === (node as BacklogFeature).parentId) ?? null;
  }
  return null;
}

/* ── Constants ──────────────────────────────────────────────── */

const TYPE_COLORS: Record<string, string> = {
  Epic: 'type-epic',
  Feature: 'type-feature',
  PBI: 'type-pbi',
};

const PRIORITY_COLORS: Record<string, string> = {
  Critical: 'priority-critical',
  High: 'priority-high',
  Medium: 'priority-medium',
  Low: 'priority-low',
};

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'status-draft',
  Approved: 'status-approved',
  Accepted: 'status-accepted',
  Merged: 'status-merged',
  Rejected: 'status-rejected',
};

/* ── Props ──────────────────────────────────────────────────── */

interface BacklogDetailsPanelProps {
  node: BacklogNode;
  document: BacklogDocumentPayload;
  pagePath: string;
  project: string;
  areaPath: string;
  onClose: () => void;
  onSelectNode: (node: BacklogNode) => void;
}

/* ── Main component ─────────────────────────────────────────── */

export const BacklogDetailsPanel: React.FC<BacklogDetailsPanelProps> = ({
  node,
  document,
  pagePath,
  project,
  areaPath,
  onClose,
  onSelectNode,
}) => {
  const queryClient = useQueryClient();
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.min(Math.round(window.innerWidth * 0.45), 720)
  );
  const [isResizing, setIsResizing] = useState(false);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [createResult, setCreateResult] = useState<{
    epicAdoId: number;
    epicAdoUrl: string;
    featuresCreated: number;
    pbisCreated: number;
    featureMap: Record<string, number>;
    pbiMap: Record<string, number>;
  } | null>(null);
  const [showCreatePbiConfirm, setShowCreatePbiConfirm] = useState(false);
  const [showUnlinkAdoConfirm, setShowUnlinkAdoConfirm] = useState(false);
  const [pbiCreateResult, setPbiCreateResult] = useState<{
    pbiAdoId: number;
    pbiAdoUrl: string;
    featureAdoId?: number;
    featureAdoUrl?: string;
  } | null>(null);
  const [showGeneratePBI, setShowGeneratePBI] = useState(false);
  const [showGenerateFeature, setShowGenerateFeature] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [clarificationResult, setClarificationResult] = useState<ClarificationResolution | null>(null);
  const [showKickoffModal, setShowKickoffModal] = useState(false);

  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: nodeToFormValues(node),
  });

  const { fields: acFields, append: appendAC, remove: removeAC } = useFieldArray<EditFormValues, 'acceptanceCriteria', 'id'>({
    control: form.control,
    name: 'acceptanceCriteria',
  });

  const watchFeatureFlag = form.watch('featureFlag');

  // Reset form when the selected node changes
  useEffect(() => {
    form.reset(nodeToFormValues(node));
    setMode('view');
    setSaveError(null);
    setClarificationResult(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  // Close on Escape (only in view mode; edit mode uses Cancel)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode === 'view') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, mode]);

  // Resize logic
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = window.innerWidth - e.clientX;
      const maxWidth = Math.floor(window.innerWidth * 0.7);
      if (newWidth >= 300 && newWidth <= maxWidth) {
        setPanelWidth(newWidth);
      }
    };
    const handleMouseUp = () => setIsResizing(false);
    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Mutation
  const mutation = useMutation({
    mutationFn: (updatedNode: BacklogNode) => {
      const updatedPayload = buildUpdatedPayload(updatedNode, document);
      return saveDraftDoc(pagePath, updatedPayload, project, areaPath);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
      setMode('view');
      setSaveError(null);
    },
    onError: (err: Error) => {
      setSaveError(err.message);
    },
  });

  const createAdoMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/backlog/create-ado-items', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epicId: node.id, document, project, areaPath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Failed: ${res.status}`);
      }
      return res.json() as Promise<{
        epicAdoId: number;
        epicAdoUrl: string;
        featuresCreated: number;
        pbisCreated: number;
        featureMap: Record<string, number>;
        pbiMap: Record<string, number>;
      }>;
    },
    onSuccess: (data) => {
      setShowCreateConfirm(false);
      setCreateResult(data);
      setSaveError(null);

      // Build the ADO URL for any work item id using the ADO org + project from env
      const adoBase = `https://dev.azure.com/${import.meta.env.VITE_ADO_ORG ?? 'amergis'}`;
      const buildUrl = (adoId: number) =>
        `${adoBase}/${encodeURIComponent(project)}/_workitems/edit/${adoId}`;

      // Stamp the Epic with Merged + ADO link
      const updatedEpic: BacklogEpic = {
        ...(node as BacklogEpic),
        status: 'Merged',
        adoWorkItemId: data.epicAdoId,
        adoWorkItemUrl: data.epicAdoUrl,
      };

      // Stamp every Feature and PBI that was pushed to ADO
      const updatedFeatures: BacklogFeature[] = document.features.map(f => {
        const adoId = data.featureMap[f.id];
        if (!adoId) return f;
        return { ...f, status: 'Merged', adoWorkItemId: adoId, adoWorkItemUrl: buildUrl(adoId) };
      });
      const updatedPBIs: BacklogPBI[] = document.pbis.map(p => {
        const adoId = data.pbiMap[p.id];
        if (!adoId) return p;
        return { ...p, status: 'Merged', adoWorkItemId: adoId, adoWorkItemUrl: buildUrl(adoId) };
      });

      const updatedPayload: BacklogDocumentPayload = {
        ...document,
        epics: document.epics.map(e => (e.id === node.id ? updatedEpic : e)),
        features: updatedFeatures,
        pbis: updatedPBIs,
      };

      saveDraftDoc(pagePath, updatedPayload, project, areaPath)
        .then(() => queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] }))
        .catch((err: Error) => setSaveError(err.message));
    },
    onError: (err: Error) => {
      setShowCreateConfirm(false);
      setSaveError(err.message);
    },
  });

  const createPbiAdoMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/backlog/create-pbi-ado-item', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pbiId: node.id, document, project, areaPath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Failed: ${res.status}`);
      }
      return res.json() as Promise<{
        pbiAdoId: number;
        pbiAdoUrl: string;
        featureAdoId?: number;
        featureAdoUrl?: string;
      }>;
    },
    onSuccess: (data) => {
      setShowCreatePbiConfirm(false);
      setSaveError(null);
      setPbiCreateResult(data);

      const updatedPBIs: BacklogPBI[] = document.pbis.map(p =>
        p.id === node.id
          ? { ...p, status: 'Merged', adoWorkItemId: data.pbiAdoId, adoWorkItemUrl: data.pbiAdoUrl }
          : p
      );

      const updatedFeatures: BacklogFeature[] = data.featureAdoId
        ? document.features.map(f =>
            f.id === (node as BacklogPBI).parentId
              ? { ...f, status: 'Merged', adoWorkItemId: data.featureAdoId, adoWorkItemUrl: data.featureAdoUrl }
              : f
          )
        : document.features;

      const updatedPayload: BacklogDocumentPayload = { ...document, features: updatedFeatures, pbis: updatedPBIs };
      saveDraftDoc(pagePath, updatedPayload, project, areaPath)
        .then(() => queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] }))
        .catch((err: Error) => setSaveError(err.message));
    },
    onError: (err: Error) => {
      setShowCreatePbiConfirm(false);
      setSaveError(err.message);
    },
  });

  const unlinkAdoMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/backlog/unlink-ado-item', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: node.id, workItemType: node.workItemType, pagePath, document, project, areaPath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Failed: ${res.status}`);
      }
      return res.json() as Promise<{ success: boolean; adoDeleteError?: string }>;
    },
    onSuccess: () => {
      setShowUnlinkAdoConfirm(false);
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
    },
    onError: (err: Error) => {
      setShowUnlinkAdoConfirm(false);
      setSaveError(err.message);
    },
  });

  const addPBIMutation = useMutation({
    mutationFn: (newPBI: BacklogPBI) => {
      const updatedPayload: BacklogDocumentPayload = {
        ...document,
        pbis: [...document.pbis, newPBI],
      };
      return saveDraftDoc(pagePath, updatedPayload, project, areaPath);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
      setShowGeneratePBI(false);
      setSaveError(null);
    },
    onError: (err: Error) => {
      setSaveError(err.message);
    },
  });

  const handleAddGeneratedPBI = (generated: GeneratedPBIData) => {
    const newId = generateBacklogId('PBI', document.pbis.map(p => p.id));

    const newPBI: BacklogPBI = {
      id: newId,
      parentId: node.id,
      workItemType: 'PBI',
      status: 'Draft',
      title: generated.title,
      description: generated.description || undefined,
      acceptanceCriteria: generated.acceptanceCriteria.length > 0 ? generated.acceptanceCriteria : undefined,
      priority: generated.priority || undefined,
      confidence: generated.confidence || undefined,
      tags: generated.tags.length > 0 ? generated.tags : undefined,
    };

    addPBIMutation.mutate(newPBI);
  };

  const addFeatureMutation = useMutation({
    mutationFn: ({ feature, pbis }: { feature: BacklogFeature; pbis: BacklogPBI[] }) => {
      const updatedPayload: BacklogDocumentPayload = {
        ...document,
        features: [...document.features, feature],
        pbis: [...document.pbis, ...pbis],
      };
      return saveDraftDoc(pagePath, updatedPayload, project, areaPath);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
      setShowGenerateFeature(false);
      setSaveError(null);
    },
    onError: (err: Error) => {
      setSaveError(err.message);
    },
  });

  const handleAddGeneratedFeature = (data: GeneratedFeatureWithPBIs) => {
    const newFeatId = generateBacklogId('FEAT', document.features.map(f => f.id));

    const newFeature: BacklogFeature = {
      id: newFeatId,
      parentId: node.id,
      workItemType: 'Feature',
      status: 'Draft',
      title: data.feature.title,
      description: data.feature.description || undefined,
      priority: data.feature.priority || undefined,
      confidence: data.feature.confidence || undefined,
      tags: data.feature.tags?.length > 0 ? data.feature.tags : undefined,
      clarificationNeeded: data.feature.clarificationNeeded || undefined,
    };

    const existingPbiIds = document.pbis.map(p => p.id);
    const newPBIs: BacklogPBI[] = data.pbis.map((pbi, i) => ({
      id: generateBacklogId('PBI', existingPbiIds, i),
      parentId: newFeatId,
      workItemType: 'PBI',
      status: 'Draft',
      title: pbi.title,
      description: pbi.description || undefined,
      acceptanceCriteria: pbi.acceptanceCriteria?.length > 0 ? pbi.acceptanceCriteria : undefined,
      priority: pbi.priority || undefined,
      confidence: pbi.confidence || undefined,
      tags: pbi.tags?.length > 0 ? pbi.tags : undefined,
    }));

    addFeatureMutation.mutate({ feature: newFeature, pbis: newPBIs });
  };

  const deleteMutation = useMutation({
    mutationFn: async ({ deleteFromADO }: { deleteFromADO: boolean }) => {
      const adoId = (node as any).adoWorkItemId as number | undefined;
      const res = await fetch('/api/backlog/item', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: node.id,
          workItemType: node.workItemType,
          pagePath,
          document,
          project,
          areaPath,
          deleteFromADO: deleteFromADO && !!adoId,
          adoWorkItemId: adoId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Delete failed: ${res.status}`);
      }
      return res.json() as Promise<{ success: boolean; adoDeleteError?: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
      setShowDeleteConfirm(false);
      if (data.adoDeleteError) {
        setSaveError(`Removed from backlog, but ADO delete failed: ${data.adoDeleteError}`);
      } else {
        setSaveError(null);
        onClose();
      }
    },
    onError: (err: Error) => {
      setShowDeleteConfirm(false);
      setSaveError(err.message);
    },
  });

  const resolveClarificationMutation = useMutation({
    mutationFn: async (answer: string) => {
      const res = await fetch('/api/backlog/resolve-clarification', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: node.id,
          workItemType: node.workItemType,
          pagePath,
          document,
          project,
          areaPath,
          clarificationQuestion: (node as any).clarificationNeeded,
          userAnswer: answer,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Failed: ${res.status}`);
      }
      return res.json() as Promise<{
        success: boolean;
        action: 'update' | 'create-feature' | 'create-pbi';
        reasoning: string;
        featureTitle?: string;
        pbisCreated?: number;
        pbiTitle?: string;
        parentFeatureTitle?: string;
      }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
      setClarificationResult({
        action: data.action,
        reasoning: data.reasoning,
        featureTitle: data.featureTitle,
        pbisCreated: data.pbisCreated,
        pbiTitle: data.pbiTitle,
        parentFeatureTitle: data.parentFeatureTitle,
      });
      setSaveError(null);
    },
    onError: (err: Error) => {
      setSaveError(err.message);
    },
  });

  const handleAnswerClarification = (answer: string) => {
    setSaveError(null);
    resolveClarificationMutation.mutate(answer);
  };

  const handleApprove = () => {
    setSaveError(null);
    mutation.mutate({ ...node, status: 'Approved' } as BacklogNode);
  };

  const handleReject = () => {
    setSaveError(null);
    mutation.mutate({ ...node, status: 'Rejected' } as BacklogNode);
  };

  const handleResetDraft = () => {
    setSaveError(null);
    mutation.mutate({ ...node, status: 'Draft' } as BacklogNode);
  };

  const handleKickoffInitiated = () => {
    if (node.workItemType !== 'PBI') return;
    // Invalidate cached ADO tags so the button re-checks the live value
    if (pbiAdoWorkItemId) {
      queryClient.invalidateQueries({ queryKey: ['ado-work-item-tags', pbiAdoWorkItemId, project] });
    }
  };

  const handleSaveEdit = (values: EditFormValues) => {
    const updatedNode = formValuesToNode(values, node);
    mutation.mutate(updatedNode);
  };

  const handleCancelEdit = () => {
    form.reset(nodeToFormValues(node));
    setMode('view');
    setSaveError(null);
  };

  const breadcrumb = buildBreadcrumb(node, document);
  const parentNode = getParentNode(node, document);
  const typeClass = TYPE_COLORS[node.workItemType] ?? '';
  const priorityClass = PRIORITY_COLORS[(node as any).priority ?? ''] ?? '';
  const statusClass = STATUS_CLASSES[node.status] ?? 'status-draft';

  const pbiNode = node.workItemType === 'PBI' ? (node as BacklogPBI) : null;
  const featureNode = node.workItemType === 'Feature' ? (node as BacklogFeature) : null;
  const isSaving = mutation.isPending;

  // Fetch the live ADO tags for this PBI to check if kickoff was already initiated
  const pbiAdoWorkItemId = node.workItemType === 'PBI' ? (node as BacklogPBI).adoWorkItemId : undefined;
  const { data: adoTagsData } = useQuery({
    queryKey: ['ado-work-item-tags', pbiAdoWorkItemId, project],
    queryFn: async () => {
      const res = await fetch(
        `/api/backlog/ado-work-item-tags?workItemId=${pbiAdoWorkItemId}&project=${encodeURIComponent(project)}`,
        { credentials: 'include' }
      );
      if (!res.ok) return { tags: [] as string[] };
      return res.json() as Promise<{ tags: string[] }>;
    },
    enabled: !!pbiAdoWorkItemId,
    staleTime: 30_000,
  });

  // Begin Development eligibility — PBI only, all three levels must be Merged
  const isDevReady = (s: string) => s === 'Merged';
  const kickoffAlreadyInitiated =
    node.workItemType === 'PBI' && !!(adoTagsData?.tags ?? []).includes('ai-code');
  const startDevBlocker = (() => {
    if (node.workItemType !== 'PBI') return null;
    if (kickoffAlreadyInitiated) return 'Design doc kickoff already initiated';
    if (!isDevReady(node.status)) return 'This PBI must be Merged';
    const parentFeat = document.features.find(f => f.id === (node as BacklogPBI).parentId);
    if (!parentFeat || !isDevReady(parentFeat.status)) return 'Parent Feature must be Merged';
    const parentEpic = document.epics.find(e => e.id === parentFeat.parentId);
    if (!parentEpic || !isDevReady(parentEpic.status)) return 'Parent Epic must be Merged';
    return null;
  })();
  const canStartDev = node.workItemType === 'PBI' && startDevBlocker === null;
  const isCreating = createAdoMutation.isPending;
  const isCreatingPbi = createPbiAdoMutation.isPending;
  const isDeleting = deleteMutation.isPending;
  const isEpic = node.workItemType === 'Epic';

  // PBI-level ADO creation: eligible when parent Feature is Approved/Merged and PBI not yet in ADO
  const isAdoReady = (s: string) => s === 'Approved' || s === 'Merged';
  const pbiAdoBlocker = (() => {
    if (node.workItemType !== 'PBI') return null;
    if ((node as BacklogPBI).adoWorkItemId) return 'This PBI is already in ADO';
    if (!isAdoReady(node.status)) return 'PBI must be Approved or Merged';
    const parentFeat = document.features.find(f => f.id === (node as BacklogPBI).parentId);
    if (!parentFeat) return 'Parent Feature not found';
    if (!isAdoReady(parentFeat.status)) return 'Parent Feature must be Approved or Merged';
    return null;
  })();
  const canCreatePbiAdo = node.workItemType === 'PBI' && pbiAdoBlocker === null;

  // ADO link: prefer the value persisted in the wiki document for any type;
  // fall back to current-session createResult for the Epic.
  const adoLink: { id: number; url: string } | null = (() => {
    const n = node as any;
    if (n.adoWorkItemUrl && typeof n.adoWorkItemId === 'number') {
      return { id: n.adoWorkItemId as number, url: n.adoWorkItemUrl as string };
    }
    if (isEpic && createResult) {
      return { id: createResult.epicAdoId, url: createResult.epicAdoUrl };
    }
    return null;
  })();

  return (
    <div
      className={`backlog-details-panel${isResizing ? ' is-resizing' : ''}`}
      style={{ width: `${panelWidth}px` }}
    >
      {/* Resize handle */}
      <div className="backlog-resize-handle" onMouseDown={handleResizeStart} />

      {/* Header */}
      <div className="bdp-header">
        <div className="bdp-header-top">
          <div className="bdp-type-row">
            <span className={`bdp-type-chip ${typeClass}`}>{node.workItemType}</span>
            <span className="bdp-node-id">{node.id}</span>
            {node.status && (
              <span className={`bdp-status ${statusClass}`}>{node.status}</span>
            )}
          </div>
          <button className="bdp-close-btn" onClick={onClose} title="Close (Esc)" disabled={isSaving}>
            ✕
          </button>
        </div>
        <h2 className="bdp-title">{node.title}</h2>

        {/* Breadcrumb */}
        {breadcrumb.length > 1 && (
          <div className="bdp-breadcrumb">
            {breadcrumb.map((crumb, i) => (
              <React.Fragment key={crumb.id}>
                {i > 0 && <span className="bdp-breadcrumb-sep">›</span>}
                {crumb.id === node.id ? (
                  <span className="bdp-breadcrumb-current">{crumb.title}</span>
                ) : (
                  <button
                    className="bdp-breadcrumb-link"
                    onClick={() => onSelectNode(crumb)}
                  >
                    {crumb.title}
                  </button>
                )}
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Action bar */}
        <div className="bdp-actions">
          {mode === 'view' ? (
            <>
              {/* Row 1 — status transitions */}
              <div className="bdp-actions-row bdp-actions-status-row">
                <span className="bdp-actions-label">Status</span>
                <div className="bdp-status-btn-group">
                  <button
                    className={`btn-status-approve${node.status === 'Approved' ? ' is-active' : ''}`}
                    onClick={handleApprove}
                    disabled={node.status === 'Approved' || isSaving}
                    title="Mark as Approved"
                  >
                    ✓ Approve
                  </button>
                  <button
                    className={`btn-status-reject${node.status === 'Rejected' ? ' is-active' : ''}`}
                    onClick={handleReject}
                    disabled={node.status === 'Rejected' || isSaving}
                    title="Mark as Rejected"
                  >
                    ✕ Reject
                  </button>
                  <button
                    className={`btn-status-draft${node.status === 'Draft' ? ' is-active' : ''}`}
                    onClick={handleResetDraft}
                    disabled={node.status === 'Draft' || isSaving}
                    title="Reset to Draft"
                  >
                    ↩ Draft
                  </button>
                </div>
              </div>

              {/* Row 2 — item actions */}
              <div className="bdp-actions-row bdp-actions-item-row">
                <button
                  className="btn-edit"
                  onClick={() => setMode('edit')}
                  disabled={isSaving}
                  title="Edit metadata"
                >
                  ✎ Edit
                </button>
                {node.workItemType === 'PBI' && (
                  <button
                    className={`btn-begin-dev${canStartDev ? ' btn-begin-dev--ready' : ''}`}
                    disabled={!canStartDev || isSaving}
                    title={canStartDev ? 'Begin Development for this PBI' : (startDevBlocker ?? '')}
                    onClick={() => setShowKickoffModal(true)}
                  >
                    ▶ Begin Development
                  </button>
                )}
                {node.workItemType === 'PBI' && (
                  <button
                    className={`btn-create-ado${canCreatePbiAdo ? ' btn-create-ado--ready' : ''}`}
                    disabled={!canCreatePbiAdo || isSaving || isCreatingPbi || isDeleting}
                    title={canCreatePbiAdo ? 'Create this PBI in Azure DevOps' : (pbiAdoBlocker ?? '')}
                    onClick={() => setShowCreatePbiConfirm(true)}
                  >
                    {isCreatingPbi ? 'Creating…' : '⊕ Create ADO'}
                  </button>
                )}
                {isEpic && (() => {
                  const epicAdoBlocker = adoLink
                    ? 'This Epic is already in ADO'
                    : !isAdoReady(node.status)
                      ? 'Epic must be Approved or Merged'
                      : null;
                  const canCreateEpicAdo = epicAdoBlocker === null;
                  return (
                    <button
                      className={`btn-create-ado${canCreateEpicAdo ? ' btn-create-ado--ready' : ''}`}
                      onClick={() => { setCreateResult(null); setShowCreateConfirm(true); }}
                      disabled={!canCreateEpicAdo || isSaving || isCreating || isDeleting}
                      title={canCreateEpicAdo ? 'Create ADO items for this Epic' : (epicAdoBlocker ?? '')}
                    >
                      ⊕ Create ADO Items
                    </button>
                  );
                })()}
                <button
                  className="btn-delete-item"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={isSaving || isCreating || isDeleting}
                  title={`Delete this ${node.workItemType}`}
                >
                  {isDeleting ? 'Deleting…' : '⊘ Delete'}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                className="btn-save"
                onClick={form.handleSubmit(handleSaveEdit)}
                disabled={isSaving}
              >
                {isSaving ? 'Saving…' : '✓ Save'}
              </button>
              <button
                className="btn-cancel"
                onClick={handleCancelEdit}
                disabled={isSaving}
              >
                Cancel
              </button>
            </>
          )}
        </div>

        {saveError && (
          <div className="bdp-save-error" role="alert">
            {saveError}
          </div>
        )}

        {createResult && (() => {
          const adoBase = `https://dev.azure.com/${import.meta.env.VITE_ADO_ORG ?? 'amergis'}`;
          const buildAdoUrl = (adoId: number) =>
            `${adoBase}/${encodeURIComponent(project)}/_workitems/edit/${adoId}`;
          const featureEntries = Object.entries(createResult.featureMap);
          const pbiEntries = Object.entries(createResult.pbiMap);
          return (
            <div className="bdp-create-success" role="status">
              <div className="bdp-create-success-body">
                <div className="bdp-create-success-row">
                  <strong>ADO items created —</strong>
                  <a
                    className="bdp-ado-link"
                    href={createResult.epicAdoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Epic #{createResult.epicAdoId} ↗
                  </a>
                </div>
                {featureEntries.length > 0 && (
                  <div className="bdp-create-success-row bdp-create-success-sub">
                    <span className="bdp-create-success-label">Features:</span>
                    {featureEntries.map(([, adoId]) => (
                      <a
                        key={adoId}
                        className="bdp-ado-link"
                        href={buildAdoUrl(adoId)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        #{adoId} ↗
                      </a>
                    ))}
                  </div>
                )}
                {pbiEntries.length > 0 && (
                  <div className="bdp-create-success-row bdp-create-success-sub">
                    <span className="bdp-create-success-label">PBIs:</span>
                    {pbiEntries.map(([, adoId]) => (
                      <a
                        key={adoId}
                        className="bdp-ado-link"
                        href={buildAdoUrl(adoId)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        #{adoId} ↗
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <button className="bdp-create-success-close" onClick={() => setCreateResult(null)}>✕</button>
            </div>
          );
        })()}

        {pbiCreateResult && (
          <div className="bdp-create-success" role="status">
            <div className="bdp-create-success-body">
              <div className="bdp-create-success-row">
                <strong>PBI created in ADO —</strong>
                <a
                  className="bdp-ado-link"
                  href={pbiCreateResult.pbiAdoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  PBI #{pbiCreateResult.pbiAdoId} ↗
                </a>
              </div>
              {pbiCreateResult.featureAdoId && pbiCreateResult.featureAdoUrl && (
                <div className="bdp-create-success-row bdp-create-success-sub">
                  <span className="bdp-create-success-label">Feature also created:</span>
                  <a
                    className="bdp-ado-link"
                    href={pbiCreateResult.featureAdoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    #{pbiCreateResult.featureAdoId} ↗
                  </a>
                </div>
              )}
            </div>
            <button className="bdp-create-success-close" onClick={() => setPbiCreateResult(null)}>✕</button>
          </div>
        )}
      </div>

      {/* Create ADO Items confirmation modal */}
      {showCreateConfirm && (
        <CreateAdoConfirmModal
          epicTitle={node.title}
          epicId={node.id}
          epicStatus={node.status ?? 'Draft'}
          document={document}
          isCreating={isCreating}
          onConfirm={() => createAdoMutation.mutate()}
          onCancel={() => setShowCreateConfirm(false)}
        />
      )}

      {/* Create single PBI in ADO confirmation modal */}
      {showCreatePbiConfirm && node.workItemType === 'PBI' && (
        <CreatePbiAdoConfirmModal
          pbi={node as BacklogPBI}
          document={document}
          isCreating={isCreatingPbi}
          onConfirm={() => createPbiAdoMutation.mutate()}
          onCancel={() => setShowCreatePbiConfirm(false)}
        />
      )}

      {/* Unlink ADO work item confirmation modal */}
      {showUnlinkAdoConfirm && adoLink && (
        <UnlinkAdoConfirmModal
          node={node}
          adoId={adoLink.id}
          isDeleting={unlinkAdoMutation.isPending}
          onConfirm={() => unlinkAdoMutation.mutate()}
          onCancel={() => setShowUnlinkAdoConfirm(false)}
        />
      )}

      {/* Design doc kickoff modal */}
      {showKickoffModal && node.workItemType === 'PBI' && (
        <BeginDevKickoffModal
          pbi={node as BacklogPBI}
          onClose={() => setShowKickoffModal(false)}
          onKickoffInitiated={handleKickoffInitiated}
        />
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <DeleteConfirmModal
          node={node}
          document={document}
          isDeleting={isDeleting}
          onConfirm={(deleteFromADO) => deleteMutation.mutate({ deleteFromADO })}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* Generate PBI modal */}
      {showGeneratePBI && node.workItemType === 'Feature' && (
        <GeneratePBIModal
          feature={node as BacklogFeature}
          document={document}
          isSaving={addPBIMutation.isPending}
          onConfirm={handleAddGeneratedPBI}
          onCancel={() => setShowGeneratePBI(false)}
        />
      )}

      {/* Generate Feature modal */}
      {showGenerateFeature && node.workItemType === 'Epic' && (
        <GenerateFeatureModal
          epic={node as BacklogEpic}
          document={document}
          isSaving={addFeatureMutation.isPending}
          onConfirm={handleAddGeneratedFeature}
          onCancel={() => setShowGenerateFeature(false)}
        />
      )}

      {/* Body */}
      <div className="bdp-body">

        {mode === 'view' ? (
          <ViewBody
            node={node}
            document={document}
            priorityClass={priorityClass}
            parentNode={parentNode}
            pbiNode={pbiNode}
            featureNode={featureNode}
            onSelectNode={onSelectNode}
            adoLink={adoLink}
            onUnlinkAdo={adoLink ? () => setShowUnlinkAdoConfirm(true) : undefined}
            isUnlinkingAdo={unlinkAdoMutation.isPending}
            onGeneratePBI={node.workItemType === 'Feature' ? () => setShowGeneratePBI(true) : undefined}
            onGenerateFeature={node.workItemType === 'Epic' ? () => setShowGenerateFeature(true) : undefined}
            onAnswerClarification={handleAnswerClarification}
            isClarificationSubmitting={resolveClarificationMutation.isPending}
            clarificationResult={clarificationResult}
            pagePath={pagePath}
            project={project}
            areaPath={areaPath}
            onFeatureUpdated={(updated) => {
              queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
              onSelectNode(updated);
            }}
          />
        ) : (
          <EditForm
            form={form}
            node={node}
            acFields={acFields}
            appendAC={appendAC}
            removeAC={removeAC}
            watchFeatureFlag={watchFeatureFlag}
          />
        )}
      </div>
    </div>
  );
};

/* ── View-mode body (extracted for clarity) ─────────────────── */

interface ClarificationResolution {
  action: 'update' | 'create-feature' | 'create-pbi';
  reasoning?: string;
  /** create-feature */
  featureTitle?: string;
  pbisCreated?: number;
  /** create-pbi */
  pbiTitle?: string;
  parentFeatureTitle?: string;
}

interface ViewBodyProps {
  node: BacklogNode;
  document: BacklogDocumentPayload;
  priorityClass: string;
  parentNode: BacklogNode | null;
  pbiNode: BacklogPBI | null;
  featureNode: BacklogFeature | null;
  onSelectNode: (n: BacklogNode) => void;
  adoLink?: { id: number; url: string } | null;
  onUnlinkAdo?: () => void;
  isUnlinkingAdo?: boolean;
  onGeneratePBI?: () => void;
  onGenerateFeature?: () => void;
  onAnswerClarification?: (answer: string) => void;
  isClarificationSubmitting?: boolean;
  clarificationResult?: ClarificationResolution | null;
  pagePath: string;
  project: string;
  areaPath: string;
  onFeatureUpdated: (updated: BacklogFeature) => void;
}

/* ── Clarification answer section ───────────────────────────── */

interface ClarificationSectionProps {
  question: string;
  onSubmitAnswer: (answer: string) => void;
  isSubmitting: boolean;
  result: ClarificationResolution | null | undefined;
}

const ClarificationSection: React.FC<ClarificationSectionProps> = ({
  question,
  onSubmitAnswer,
  isSubmitting,
  result,
}) => {
  const [showAnswer, setShowAnswer] = useState(false);
  const [answer, setAnswer] = useState('');

  return (
    <div className="bdp-section bdp-clarification-section">
      <h3 className="bdp-section-title">
        <span className="bdp-clarification-icon">❓</span>
        {' '}Clarification Needed
      </h3>
      <div className="bdp-clarification">{question}</div>

      {result ? (
        <div className="bdp-clarification-resolved">
          <div className="bdp-clarification-resolved-summary">
            <span className="bdp-clarification-resolved-check">✓</span>
            <span>
              {result.action === 'update' && 'Work item updated with your answer'}
              {result.action === 'create-feature' && (
                <>
                  {'Created new Feature: '}
                  <strong>{result.featureTitle}</strong>
                  {result.pbisCreated ? ` with ${result.pbisCreated} PBI${result.pbisCreated !== 1 ? 's' : ''}` : ''}
                </>
              )}
              {result.action === 'create-pbi' && (
                <>
                  {'Created new PBI: '}
                  <strong>{result.pbiTitle}</strong>
                  {result.parentFeatureTitle ? <> {' under '}<em>{result.parentFeatureTitle}</em></> : ''}
                </>
              )}
            </span>
          </div>
          {result.reasoning && (
            <div className="bdp-clarification-reasoning">
              <span className="bdp-clarification-reasoning-label">AI reasoning</span>
              <p className="bdp-clarification-reasoning-text">{result.reasoning}</p>
            </div>
          )}
        </div>
      ) : (
        <>
          {!showAnswer ? (
            <button
              className="bdp-clarification-answer-toggle"
              onClick={() => setShowAnswer(true)}
              disabled={isSubmitting}
            >
              ↩ Answer this question
            </button>
          ) : (
            <div className="bdp-clarification-answer-box">
              <label className="bdp-edit-label">Your answer</label>
              <textarea
                className="bdp-edit-textarea bdp-clarification-answer-textarea"
                rows={3}
                placeholder="Type your answer here…"
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                disabled={isSubmitting}
                autoFocus
              />
              <div className="bdp-clarification-answer-actions">
                <button
                  className="btn-cancel"
                  onClick={() => { setShowAnswer(false); setAnswer(''); }}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  className="bdp-clarification-submit"
                  onClick={() => answer.trim() && onSubmitAnswer(answer.trim())}
                  disabled={isSubmitting || !answer.trim()}
                >
                  {isSubmitting
                    ? <><span className="bdp-gen-spinner bdp-gen-spinner--sm" aria-hidden="true" />{'  Resolving…'}</>
                    : '✦ Submit Answer'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const ViewBody: React.FC<ViewBodyProps> = ({
  node,
  document,
  priorityClass,
  parentNode,
  pbiNode,
  featureNode,
  onSelectNode,
  adoLink,
  onUnlinkAdo,
  isUnlinkingAdo,
  onGeneratePBI,
  onGenerateFeature,
  onAnswerClarification,
  isClarificationSubmitting,
  clarificationResult,
  pagePath,
  project,
  areaPath,
  onFeatureUpdated,
}) => (
  <>
    {/* Meta row */}
    <div className="bdp-meta-row">
      {(node as any).priority && (
        <div className="bdp-meta-item">
          <span className="bdp-meta-label">Priority</span>
          <span className={`bdp-priority-badge ${priorityClass}`}>{(node as any).priority}</span>
        </div>
      )}
      {(node as any).confidence && (
        <div className="bdp-meta-item">
          <span className="bdp-meta-label">Confidence</span>
          <span className="bdp-confidence">{(node as any).confidence}</span>
        </div>
      )}
      {parentNode && (
        <div className="bdp-meta-item">
          <span className="bdp-meta-label">Parent</span>
          <button className="bdp-parent-link" onClick={() => onSelectNode(parentNode)}>
            <span
              className={`bdp-type-chip ${TYPE_COLORS[parentNode.workItemType] ?? ''}`}
              style={{ fontSize: '10px', padding: '1px 6px' }}
            >
              {parentNode.workItemType}
            </span>
            {parentNode.id}
          </button>
        </div>
      )}
    </div>

    {/* Tags */}
    {(node as any).tags?.length > 0 && (
      <div className="bdp-section">
        <div className="bdp-tags">
          {(node as any).tags.map((tag: string) => (
            <span key={tag} className="bdp-tag">{tag}</span>
          ))}
        </div>
      </div>
    )}

    {/* Feature Flag (Feature only) */}
    {featureNode?.featureFlag && (
      <div className="bdp-section">
        <h3 className="bdp-section-title">Feature Flag</h3>
        <div className="bdp-ff-view">
          <span className={`bdp-ff-badge ${featureNode.featureFlag.enabled ? 'ff-enabled' : 'ff-disabled'}`}>
            {featureNode.featureFlag.enabled ? 'Enabled' : 'Disabled'}
          </span>
          {featureNode.featureFlag.name && (
            <span className="bdp-ff-name">{featureNode.featureFlag.name}</span>
          )}
        </div>
      </div>
    )}

    {/* Description */}
    {node.description && (
      <div className="bdp-section">
        <h3 className="bdp-section-title">Description</h3>
        <div className="bdp-description">
          {node.description.split('\n').map((line, i) => (
            <p key={i} className={line.trim() === '' ? 'bdp-para-spacer' : undefined}>
              {line || '\u00A0'}
            </p>
          ))}
        </div>
      </div>
    )}

    {/* Acceptance Criteria (PBI only) */}
    {pbiNode?.acceptanceCriteria && pbiNode.acceptanceCriteria.length > 0 && (
      <div className="bdp-section">
        <h3 className="bdp-section-title">Acceptance Criteria</h3>
        <ol className="bdp-ac-list">
          {pbiNode.acceptanceCriteria.map((ac, i) => (
            <li key={i} className="bdp-ac-item">{ac}</li>
          ))}
        </ol>
      </div>
    )}

    {/* Source Evidence */}
    {(node as any).sourceEvidence && (
      <div className="bdp-section">
        <h3 className="bdp-section-title">Source Evidence</h3>
        <div className="bdp-source-evidence">{(node as any).sourceEvidence}</div>
      </div>
    )}

    {/* Clarification Needed */}
    {(node as any).clarificationNeeded && onAnswerClarification && (
      <ClarificationSection
        question={(node as any).clarificationNeeded}
        onSubmitAnswer={onAnswerClarification}
        isSubmitting={isClarificationSubmitting ?? false}
        result={clarificationResult}
      />
    )}
    {(node as any).clarificationNeeded && !onAnswerClarification && (
      <div className="bdp-section">
        <h3 className="bdp-section-title">Clarification Needed</h3>
        <div className="bdp-clarification">{(node as any).clarificationNeeded}</div>
      </div>
    )}

    {/* Child summary for Epics & Features */}
    {node.workItemType === 'Epic' && (
      <ChildSummary
        epicId={node.id}
        document={document}
        onSelectNode={onSelectNode}
        onGenerateFeature={onGenerateFeature}
      />
    )}
    {node.workItemType === 'Feature' && (
      <FeatureChildSummary
        featureId={node.id}
        document={document}
        onSelectNode={onSelectNode}
        onGeneratePBI={onGeneratePBI}
      />
    )}

    {/* UI Mock — Feature only */}
    {featureNode && (
      <div className="bdp-section">
        <UiMockSection
          feature={featureNode}
          document={document}
          pagePath={pagePath}
          project={project}
          areaPath={areaPath}
          onFeatureUpdated={onFeatureUpdated}
        />
      </div>
    )}

    {/* ADO link — shown for any work item type once created in ADO */}
    {adoLink && (
      <div className="bdp-section">
        <h3 className="bdp-section-title">Azure DevOps</h3>
        <div className="bdp-ado-section-row">
          <a
            className="bdp-ado-workitem-link"
            href={adoLink.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="bdp-ado-workitem-icon">↗</span>
            <span>View {node.workItemType} #{adoLink.id} in Azure DevOps</span>
          </a>
          {onUnlinkAdo && (
            <button
              className="btn-unlink-ado"
              onClick={onUnlinkAdo}
              disabled={isUnlinkingAdo}
              title="Delete this work item from Azure DevOps and reset status to Draft"
            >
              {isUnlinkingAdo ? 'Deleting…' : '⊗ Delete from ADO'}
            </button>
          )}
        </div>
      </div>
    )}
  </>
);

/* ── Edit-mode form ─────────────────────────────────────────── */

interface EditFormProps {
  form: ReturnType<typeof useForm<EditFormValues>>;
  node: BacklogNode;
  acFields: FieldArrayWithId<EditFormValues, 'acceptanceCriteria', 'id'>[];
  appendAC: UseFieldArrayAppend<EditFormValues, 'acceptanceCriteria'>;
  removeAC: UseFieldArrayRemove;
  watchFeatureFlag: EditFormValues['featureFlag'];
}

const PRIORITY_OPTIONS = ['', 'Critical', 'High', 'Medium', 'Low'];
const CONFIDENCE_OPTIONS = ['', 'High', 'Medium', 'Low'];
const STATUS_OPTIONS = ['Draft', 'Approved', 'Accepted', 'Merged', 'Rejected'];

const EditForm: React.FC<EditFormProps> = ({
  form,
  node,
  acFields,
  appendAC,
  removeAC,
  watchFeatureFlag,
}) => {
  const { register, formState: { errors } } = form;
  const isFeature = node.workItemType === 'Feature';
  const isPBI = node.workItemType === 'PBI';

  return (
    <div className="bdp-edit-form">
      {/* Title */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-title">Title</label>
        <input
          id="edit-title"
          className={`bdp-edit-input${errors.title ? ' input-error' : ''}`}
          {...register('title')}
        />
        {errors.title && <span className="bdp-field-error">{errors.title.message}</span>}
      </div>

      {/* Status */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-status">Status</label>
        <select id="edit-status" className="bdp-edit-select" {...register('status')}>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Priority */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-priority">Priority</label>
        <select id="edit-priority" className="bdp-edit-select" {...register('priority')}>
          {PRIORITY_OPTIONS.map(p => (
            <option key={p} value={p}>{p || '(none)'}</option>
          ))}
        </select>
      </div>

      {/* Confidence */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-confidence">Confidence</label>
        <select id="edit-confidence" className="bdp-edit-select" {...register('confidence')}>
          {CONFIDENCE_OPTIONS.map(c => (
            <option key={c} value={c}>{c || '(none)'}</option>
          ))}
        </select>
      </div>

      {/* Tags */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-tags">Tags (comma-separated)</label>
        <input
          id="edit-tags"
          className="bdp-edit-input"
          placeholder="e.g. RTO, Notifications, Client"
          {...register('tags')}
        />
      </div>

      {/* Feature Flag (Feature only) */}
      {isFeature && (
        <div className="bdp-edit-field bdp-ff-section">
          <span className="bdp-edit-label">Feature Flag</span>
          <div className="bdp-ff-toggle-row">
            <label className="bdp-ff-toggle">
              <input type="checkbox" {...register('featureFlag.enabled')} />
              <span className="bdp-ff-toggle-label">
                {watchFeatureFlag?.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
            {watchFeatureFlag?.enabled && (
              <input
                className="bdp-edit-input bdp-ff-name-input"
                placeholder="Flag name (optional)"
                {...register('featureFlag.name')}
              />
            )}
          </div>
        </div>
      )}

      {/* Description */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-description">Description</label>
        <textarea
          id="edit-description"
          className="bdp-edit-textarea"
          rows={6}
          {...register('description')}
        />
      </div>

      {/* Acceptance Criteria (PBI only) */}
      {isPBI && (
        <div className="bdp-edit-field">
          <label className="bdp-edit-label">Acceptance Criteria</label>
          <div className="bdp-ac-edit-list">
            {(acFields as any[]).map((field, index) => (
              <div key={field.id} className="bdp-ac-edit-row">
                <span className="bdp-ac-edit-num">{index + 1}.</span>
                <textarea
                  className="bdp-edit-textarea bdp-ac-edit-textarea"
                  rows={2}
                  {...register(`acceptanceCriteria.${index}.value`)}
                />
                <button
                  type="button"
                  className="btn-ac-remove"
                  onClick={() => removeAC(index)}
                  title="Remove criterion"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-ac-add"
              onClick={() => appendAC({ value: '' })}
            >
              + Add criterion
            </button>
          </div>
        </div>
      )}

      {/* Source Evidence */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-source">Source Evidence</label>
        <textarea
          id="edit-source"
          className="bdp-edit-textarea"
          rows={3}
          {...register('sourceEvidence')}
        />
      </div>

      {/* Clarification Needed */}
      <div className="bdp-edit-field">
        <label className="bdp-edit-label" htmlFor="edit-clarification">Clarification Needed</label>
        <textarea
          id="edit-clarification"
          className="bdp-edit-textarea"
          rows={3}
          {...register('clarificationNeeded')}
        />
      </div>
    </div>
  );
};

/* ── Child summary helpers ─────────────────────────────────── */

interface ChildSummaryProps {
  epicId: string;
  document: BacklogDocumentPayload;
  onSelectNode: (n: BacklogNode) => void;
  onGenerateFeature?: () => void;
}

const ChildSummary: React.FC<ChildSummaryProps> = ({
  epicId,
  document,
  onSelectNode,
  onGenerateFeature,
}) => {
  const features = document.features.filter(f => f.parentId === epicId);

  return (
    <div className="bdp-section">
      <div className="bdp-section-header">
        <h3 className="bdp-section-title">
          Features{features.length > 0 ? ` (${features.length})` : ''}
        </h3>
        {onGenerateFeature && (
          <button
            className="btn-generate-feature"
            onClick={onGenerateFeature}
            title="Generate a new Feature with AI"
          >
            ✦ Generate Feature
          </button>
        )}
      </div>
      {features.length > 0 ? (
        <div className="bdp-child-list">
          {features.map(f => (
            <button key={f.id} className="bdp-child-item" onClick={() => onSelectNode(f)}>
              <span className="bdp-type-chip type-feature" style={{ fontSize: '10px', padding: '1px 6px' }}>Feature</span>
              <span className="bdp-child-id">{f.id}</span>
              <span className="bdp-child-title">{f.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="bdp-empty-children">No Features yet. Use Generate Feature to add one.</p>
      )}
    </div>
  );
};

interface FeatureChildSummaryProps {
  featureId: string;
  document: BacklogDocumentPayload;
  onSelectNode: (n: BacklogNode) => void;
  onGeneratePBI?: () => void;
}

const FeatureChildSummary: React.FC<FeatureChildSummaryProps> = ({
  featureId,
  document,
  onSelectNode,
  onGeneratePBI,
}) => {
  const pbis = document.pbis.filter(p => p.parentId === featureId);

  return (
    <div className="bdp-section">
      <div className="bdp-section-header">
        <h3 className="bdp-section-title">
          Product Backlog Items{pbis.length > 0 ? ` (${pbis.length})` : ''}
        </h3>
        {onGeneratePBI && (
          <button
            className="btn-generate-pbi"
            onClick={onGeneratePBI}
            title="Generate a new PBI with AI"
          >
            ✦ Generate PBI
          </button>
        )}
      </div>
      {pbis.length > 0 ? (
        <div className="bdp-child-list">
          {pbis.map(p => (
            <button key={p.id} className="bdp-child-item" onClick={() => onSelectNode(p)}>
              <span className="bdp-type-chip type-pbi" style={{ fontSize: '10px', padding: '1px 6px' }}>PBI</span>
              <span className="bdp-child-id">{p.id}</span>
              <span className="bdp-child-title">{p.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="bdp-empty-children">No PBIs yet. Use Generate PBI to add one.</p>
      )}
    </div>
  );
};

/* ── Delete Confirm Modal ────────────────────────────────── */

interface DeleteConfirmModalProps {
  node: BacklogNode;
  document: BacklogDocumentPayload;
  isDeleting: boolean;
  onConfirm: (deleteFromADO: boolean) => void;
  onCancel: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ node, document, isDeleting, onConfirm, onCancel }) => {
  const [deleteFromADO, setDeleteFromADO] = React.useState(false);
  const adoId = (node as any).adoWorkItemId as number | undefined;

  const childFeatures = node.workItemType === 'Epic'
    ? document.features.filter(f => f.parentId === node.id)
    : [];
  const childFeatureIds = new Set(childFeatures.map(f => f.id));

  const childPBIs = node.workItemType === 'Epic'
    ? document.pbis.filter(p => childFeatureIds.has(p.parentId))
    : node.workItemType === 'Feature'
      ? document.pbis.filter(p => p.parentId === node.id)
      : [];

  const cascadeSummary: string[] = [];
  if (node.workItemType === 'Epic') {
    cascadeSummary.push(`1 Epic`);
    if (childFeatures.length) cascadeSummary.push(`${childFeatures.length} Feature${childFeatures.length !== 1 ? 's' : ''}`);
    if (childPBIs.length) cascadeSummary.push(`${childPBIs.length} PBI${childPBIs.length !== 1 ? 's' : ''}`);
  } else if (node.workItemType === 'Feature') {
    cascadeSummary.push(`1 Feature`);
    if (childPBIs.length) cascadeSummary.push(`${childPBIs.length} PBI${childPBIs.length !== 1 ? 's' : ''}`);
  } else {
    cascadeSummary.push('1 PBI');
  }

  return (
    <div className="bdp-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
      <div className="bdp-modal bdp-modal--delete">
        <h3 id="delete-modal-title" className="bdp-modal-title">
          <span className="bdp-delete-warning-icon">⚠</span>
          {' '}Delete {node.workItemType}
        </h3>
        <p className="bdp-delete-item-name">"{node.title}"</p>

        <div className="bdp-delete-cascade">
          <p className="bdp-delete-cascade-label">The following will be permanently removed from the backlog:</p>
          <ul className="bdp-delete-cascade-list">
            {cascadeSummary.map(s => <li key={s}>{s}</li>)}
          </ul>
        </div>

        {adoId && (
          <label className="bdp-delete-ado-check">
            <input
              type="checkbox"
              checked={deleteFromADO}
              onChange={e => setDeleteFromADO(e.target.checked)}
              disabled={isDeleting}
            />
            <span>Also delete work item <strong>#{adoId}</strong> from Azure DevOps</span>
          </label>
        )}

        <p className="bdp-delete-warning-text">This action cannot be undone.</p>

        <div className="bdp-modal-footer">
          <button className="btn-cancel" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </button>
          <button
            className="btn-delete-confirm"
            onClick={() => onConfirm(deleteFromADO)}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : '⊘ Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Generate PBI Modal ──────────────────────────────────── */

interface GeneratePBIModalProps {
  feature: BacklogFeature;
  document: BacklogDocumentPayload;
  isSaving: boolean;
  onConfirm: (generated: GeneratedPBIData) => void;
  onCancel: () => void;
}

/* ── Generate Feature Modal ──────────────────────────────── */

interface GenerateFeatureModalProps {
  epic: BacklogEpic;
  document: BacklogDocumentPayload;
  isSaving: boolean;
  onConfirm: (data: GeneratedFeatureWithPBIs) => void;
  onCancel: () => void;
}

const generateFeatureSchema = z.object({
  userRequest: z.string().min(10, 'Please describe the feature in at least 10 characters'),
});
type GenerateFeatureFormValues = z.infer<typeof generateFeatureSchema>;

const reviewFeatureSchema = z.object({
  featureTitle: z.string().min(1, 'Title is required'),
  featureDescription: z.string().min(1, 'Description is required'),
  featurePriority: z.string(),
  featureConfidence: z.string(),
  featureTags: z.string(),
  featureClarification: z.string().optional(),
  pbis: z.array(z.object({
    title: z.string().min(1, 'PBI title is required'),
    description: z.string(),
    priority: z.string(),
    confidence: z.string(),
    tags: z.string(),
    acceptanceCriteria: z.array(z.object({ value: z.string() })),
  })),
});
type ReviewFeatureFormValues = z.infer<typeof reviewFeatureSchema>;

/* ── PBI edit card (nested AC field array) ─────────────────── */

interface PBIEditCardProps {
  control: Control<ReviewFeatureFormValues>;
  register: UseFormRegister<ReviewFeatureFormValues>;
  errors: FieldErrors<ReviewFeatureFormValues>;
  index: number;
  pbiCount: number;
  onRemove: () => void;
}

const PBIEditCard: React.FC<PBIEditCardProps> = ({
  control,
  register,
  errors,
  index,
  pbiCount,
  onRemove,
}) => {
  const { fields: acFields, append: appendAC, remove: removeAC } = useFieldArray({
    control,
    name: `pbis.${index}.acceptanceCriteria`,
  });

  const pbiErrors = errors.pbis?.[index];

  return (
    <div className="bdp-gen-pbi-edit-card">
      <div className="bdp-gen-pbi-edit-header">
        <span className="bdp-gen-pbi-num">
          <span className="bdp-type-chip type-pbi" style={{ fontSize: '10px', padding: '1px 6px' }}>PBI</span>
          {index + 1}
        </span>
        {pbiCount > 1 && (
          <button type="button" className="btn-ac-remove" onClick={onRemove} title="Remove PBI">✕</button>
        )}
      </div>

      <div className="bdp-edit-field">
        <label className="bdp-edit-label">Title</label>
        <input
          className={`bdp-edit-input${pbiErrors?.title ? ' input-error' : ''}`}
          {...register(`pbis.${index}.title`)}
        />
        {pbiErrors?.title && <span className="bdp-field-error">{pbiErrors.title.message}</span>}
      </div>

      <div className="bdp-gen-meta-row">
        <div className="bdp-edit-field bdp-gen-meta-field">
          <label className="bdp-edit-label">Priority</label>
          <select className="bdp-edit-select" {...register(`pbis.${index}.priority`)}>
            {PRIORITY_OPTIONS.filter(Boolean).map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="bdp-edit-field bdp-gen-meta-field">
          <label className="bdp-edit-label">Confidence</label>
          <select className="bdp-edit-select" {...register(`pbis.${index}.confidence`)}>
            {CONFIDENCE_OPTIONS.filter(Boolean).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="bdp-edit-field">
        <label className="bdp-edit-label">Tags (comma-separated)</label>
        <input className="bdp-edit-input" {...register(`pbis.${index}.tags`)} />
      </div>

      <div className="bdp-edit-field">
        <label className="bdp-edit-label">
          Description
          <span className="bdp-gen-field-hint"> — As a [user], I want to […], so that […]</span>
        </label>
        <textarea
          className={`bdp-edit-textarea${pbiErrors?.description ? ' input-error' : ''}`}
          rows={3}
          {...register(`pbis.${index}.description`)}
        />
      </div>

      <div className="bdp-edit-field">
        <label className="bdp-edit-label">
          Acceptance Criteria
          <span className="bdp-gen-field-hint"> — Given […] When […] Then […]</span>
        </label>
        <div className="bdp-ac-edit-list">
          {(acFields as any[]).map((field, acIdx) => (
            <div key={field.id} className="bdp-ac-edit-row">
              <span className="bdp-ac-edit-num">{acIdx + 1}.</span>
              <textarea
                className="bdp-edit-textarea bdp-ac-edit-textarea"
                rows={2}
                {...register(`pbis.${index}.acceptanceCriteria.${acIdx}.value`)}
              />
              <button type="button" className="btn-ac-remove" onClick={() => removeAC(acIdx)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn-ac-add" onClick={() => appendAC({ value: '' })}>
            + Add criterion
          </button>
        </div>
      </div>
    </div>
  );
};

const GenerateFeatureModal: React.FC<GenerateFeatureModalProps> = ({
  epic,
  document,
  isSaving,
  onConfirm,
  onCancel,
}) => {
  const [step, setStep] = useState<'input' | 'generating' | 'review'>('input');
  const [reviewMode, setReviewMode] = useState<'view' | 'edit'>('view');
  const [generateError, setGenerateError] = useState<string | null>(null);

  const promptForm = useForm<GenerateFeatureFormValues>({
    resolver: zodResolver(generateFeatureSchema),
    defaultValues: { userRequest: '' },
  });

  const reviewForm = useForm<ReviewFeatureFormValues>({
    resolver: zodResolver(reviewFeatureSchema),
    defaultValues: {
      featureTitle: '',
      featureDescription: '',
      featurePriority: 'High',
      featureConfidence: 'Medium',
      featureTags: '',
      featureClarification: '',
      pbis: [],
    },
  });

  const {
    fields: pbiFields,
    append: appendPBI,
    remove: removePBI,
  } = useFieldArray<ReviewFeatureFormValues, 'pbis', 'id'>({
    control: reviewForm.control,
    name: 'pbis',
  });

  const reviewed = reviewForm.watch();

  const handleGenerate = async (values: GenerateFeatureFormValues) => {
    setStep('generating');
    setGenerateError(null);
    try {
      const res = await fetch('/api/backlog/generate-feature', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epicId: epic.id,
          document,
          userRequest: values.userRequest,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Generation failed: ${res.status}`);
      }
      const data = (await res.json()) as GeneratedFeatureWithPBIs;

      reviewForm.reset({
        featureTitle: data.feature.title,
        featureDescription: data.feature.description,
        featurePriority: data.feature.priority || 'High',
        featureConfidence: data.feature.confidence || 'Medium',
        featureTags: (data.feature.tags ?? []).join(', '),
        featureClarification: data.feature.clarificationNeeded ?? '',
        pbis: (data.pbis ?? []).map(p => ({
          title: p.title,
          description: p.description,
          priority: p.priority || 'High',
          confidence: p.confidence || 'Medium',
          tags: (p.tags ?? []).join(', '),
          acceptanceCriteria: (p.acceptanceCriteria ?? []).map(v => ({ value: v })),
        })),
      });

      setReviewMode('view');
      setStep('review');
    } catch (err: any) {
      setGenerateError(err.message ?? 'Generation failed');
      setStep('input');
    }
  };

  const handleAddToBacklog = (values: ReviewFeatureFormValues) => {
    const parseTags = (s: string) => s.split(',').map(t => t.trim()).filter(Boolean);

    const feature: GeneratedFeatureData = {
      title: values.featureTitle,
      description: values.featureDescription,
      priority: values.featurePriority,
      confidence: values.featureConfidence,
      tags: parseTags(values.featureTags),
      clarificationNeeded: values.featureClarification || undefined,
    };

    const pbis: GeneratedPBIData[] = values.pbis.map(p => ({
      title: p.title,
      description: p.description,
      priority: p.priority,
      confidence: p.confidence,
      tags: parseTags(p.tags),
      acceptanceCriteria: p.acceptanceCriteria.map(ac => ac.value).filter(Boolean),
    }));

    onConfirm({ feature, pbis });
  };

  /* derived display values for the read-only card */
  const viewFeatureTags = reviewed.featureTags
    ? reviewed.featureTags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const featPriorityClass = PRIORITY_COLORS[reviewed.featurePriority ?? ''] ?? '';
  const { register: reg, formState: { errors: revErrors }, control: revControl } = reviewForm;

  const headerTitle = step === 'review'
    ? (reviewMode === 'edit' ? 'Edit Feature & PBIs' : 'Review Generated Feature')
    : 'Generate Feature';

  return (
    <div
      className="bdp-modal-overlay"
      onClick={step === 'generating' || isSaving ? undefined : onCancel}
    >
      <div className="bdp-modal bdp-modal--generate bdp-modal--generate-feature" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="bdp-modal-header">
          <div className="bdp-modal-header-left">
            <h3 className="bdp-modal-title">{headerTitle}</h3>
            {step === 'review' && <span className="bdp-gen-ai-badge">✦ AI generated</span>}
          </div>
          <button
            className="bdp-modal-close"
            onClick={onCancel}
            disabled={step === 'generating' || isSaving}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="bdp-modal-body bdp-modal-body--scrollable">

          {/* Epic context pill */}
          <div className="bdp-gen-feature-context bdp-gen-epic-context">
            <span className="bdp-type-chip type-epic" style={{ fontSize: '10px', padding: '1px 6px' }}>
              Epic
            </span>
            <span className="bdp-gen-feature-title">{epic.title}</span>
          </div>

          {/* ── Step 1: prompt input ── */}
          {step === 'input' && (
            <>
              {generateError && <div className="bdp-save-error" role="alert">{generateError}</div>}
              <div className="bdp-gen-input-group">
                <label className="bdp-edit-label" htmlFor="feat-gen-request">
                  Describe the feature you want to add
                </label>
                <textarea
                  id="feat-gen-request"
                  className={`bdp-edit-textarea bdp-gen-textarea${promptForm.formState.errors.userRequest ? ' input-error' : ''}`}
                  rows={5}
                  placeholder={`e.g. "Allow workers to view their complete RTO history and download a summary report"`}
                  {...promptForm.register('userRequest')}
                />
                {promptForm.formState.errors.userRequest && (
                  <span className="bdp-field-error">{promptForm.formState.errors.userRequest.message}</span>
                )}
              </div>
              <p className="bdp-gen-hint">
                AI will generate a complete Feature with business rules, plus 2–4 PBIs with user story descriptions and Given/When/Then acceptance criteria.
              </p>
            </>
          )}

          {/* ── Generating spinner ── */}
          {step === 'generating' && (
            <div className="bdp-gen-loading">
              <div className="bdp-gen-spinner" aria-hidden="true" />
              <span>Generating Feature &amp; PBIs with AI…</span>
            </div>
          )}

          {/* ── Step 2a: read-only review ── */}
          {step === 'review' && reviewMode === 'view' && (
            <div className="bdp-gen-preview">
              {/* Feature card */}
              <div className="bdp-gen-feat-card">
                <div className="bdp-gen-feat-card-header">
                  <span className="bdp-type-chip type-feature" style={{ fontSize: '10px', padding: '1px 6px' }}>Feature</span>
                  <span className="bdp-gen-preview-title">{reviewed.featureTitle}</span>
                </div>
                <div className="bdp-gen-preview-meta">
                  {reviewed.featurePriority && (
                    <span className={`bdp-priority-badge ${featPriorityClass}`}>{reviewed.featurePriority}</span>
                  )}
                  {reviewed.featureConfidence && (
                    <span className="bdp-confidence">{reviewed.featureConfidence} confidence</span>
                  )}
                  {viewFeatureTags.map(tag => <span key={tag} className="bdp-tag">{tag}</span>)}
                </div>
                <div className="bdp-gen-preview-section">
                  <span className="bdp-edit-label">Description</span>
                  <div className="bdp-gen-preview-body bdp-gen-feature-desc">
                    {reviewed.featureDescription.split('\n').map((line, i) => (
                      <p key={i} className={line.trim() === '' ? 'bdp-para-spacer' : undefined}>{line || '\u00A0'}</p>
                    ))}
                  </div>
                </div>
                {reviewed.featureClarification && (
                  <div className="bdp-gen-preview-section">
                    <span className="bdp-edit-label">Clarification Needed</span>
                    <div className="bdp-clarification">{reviewed.featureClarification}</div>
                  </div>
                )}
              </div>

              {/* PBI list */}
              <div className="bdp-gen-pbi-review-list">
                <div className="bdp-gen-pbi-list-header">
                  <span className="bdp-edit-label">Product Backlog Items ({reviewed.pbis?.length ?? 0})</span>
                </div>
                {(reviewed.pbis ?? []).map((pbi, i) => {
                  const pbiTags = pbi.tags ? pbi.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
                  const pbiAC = (pbi.acceptanceCriteria ?? []).map(ac => ac.value).filter(Boolean);
                  const pbiPriClass = PRIORITY_COLORS[pbi.priority ?? ''] ?? '';
                  return (
                    <div key={i} className="bdp-gen-pbi-review-card">
                      <div className="bdp-gen-pbi-review-header">
                        <span className="bdp-type-chip type-pbi" style={{ fontSize: '10px', padding: '1px 6px' }}>PBI</span>
                        <span className="bdp-gen-pbi-review-title">{pbi.title}</span>
                      </div>
                      <div className="bdp-gen-preview-meta" style={{ marginTop: 4 }}>
                        {pbi.priority && <span className={`bdp-priority-badge ${pbiPriClass}`}>{pbi.priority}</span>}
                        {pbiTags.map(t => <span key={t} className="bdp-tag">{t}</span>)}
                      </div>
                      {pbi.description && (
                        <p className="bdp-gen-pbi-review-desc">{pbi.description}</p>
                      )}
                      {pbiAC.length > 0 && (
                        <ol className="bdp-ac-list bdp-gen-pbi-ac-list">
                          {pbiAC.map((ac, j) => <li key={j} className="bdp-ac-item">{ac}</li>)}
                        </ol>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="bdp-gen-draft-note">
                All items will be added as <strong>Draft</strong>. Use <strong>✎ Edit</strong> to adjust before adding.
              </p>
            </div>
          )}

          {/* ── Step 2b: edit form ── */}
          {step === 'review' && reviewMode === 'edit' && (
            <div className="bdp-gen-review-form">

              {/* Feature fields */}
              <div className="bdp-gen-section-divider">
                <span className="bdp-type-chip type-feature" style={{ fontSize: '10px', padding: '1px 6px' }}>Feature</span>
                <span className="bdp-gen-section-label">Feature Details</span>
              </div>
              <div className="bdp-edit-form" style={{ gap: 12 }}>
                <div className="bdp-edit-field">
                  <label className="bdp-edit-label" htmlFor="feat-review-title">Title</label>
                  <input
                    id="feat-review-title"
                    className={`bdp-edit-input${revErrors.featureTitle ? ' input-error' : ''}`}
                    {...reg('featureTitle')}
                  />
                  {revErrors.featureTitle && <span className="bdp-field-error">{revErrors.featureTitle.message}</span>}
                </div>

                <div className="bdp-gen-meta-row">
                  <div className="bdp-edit-field bdp-gen-meta-field">
                    <label className="bdp-edit-label">Priority</label>
                    <select className="bdp-edit-select" {...reg('featurePriority')}>
                      {PRIORITY_OPTIONS.filter(Boolean).map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="bdp-edit-field bdp-gen-meta-field">
                    <label className="bdp-edit-label">Confidence</label>
                    <select className="bdp-edit-select" {...reg('featureConfidence')}>
                      {CONFIDENCE_OPTIONS.filter(Boolean).map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>

                <div className="bdp-edit-field">
                  <label className="bdp-edit-label">Tags (comma-separated)</label>
                  <input className="bdp-edit-input" {...reg('featureTags')} />
                </div>

                <div className="bdp-edit-field">
                  <label className="bdp-edit-label" htmlFor="feat-review-desc">Description</label>
                  <textarea
                    id="feat-review-desc"
                    className={`bdp-edit-textarea${revErrors.featureDescription ? ' input-error' : ''}`}
                    rows={6}
                    {...reg('featureDescription')}
                  />
                  {revErrors.featureDescription && <span className="bdp-field-error">{revErrors.featureDescription.message}</span>}
                </div>

                <div className="bdp-edit-field">
                  <label className="bdp-edit-label">Clarification Needed <span className="bdp-gen-field-hint">(optional)</span></label>
                  <textarea className="bdp-edit-textarea" rows={2} {...reg('featureClarification')} />
                </div>
              </div>

              {/* PBI fields */}
              <div className="bdp-gen-section-divider" style={{ marginTop: 20 }}>
                <span className="bdp-type-chip type-pbi" style={{ fontSize: '10px', padding: '1px 6px' }}>PBI</span>
                <span className="bdp-gen-section-label">Product Backlog Items</span>
              </div>

              <div className="bdp-gen-pbi-edit-list">
                {(pbiFields as any[]).map((field, i) => (
                  <PBIEditCard
                    key={field.id}
                    control={revControl}
                    register={reg}
                    errors={revErrors}
                    index={i}
                    pbiCount={pbiFields.length}
                    onRemove={() => removePBI(i)}
                  />
                ))}
                <button
                  type="button"
                  className="btn-ac-add bdp-gen-add-pbi-btn"
                  onClick={() => appendPBI({
                    title: '',
                    description: '',
                    priority: reviewed.featurePriority || 'High',
                    confidence: 'Medium',
                    tags: reviewed.featureTags || '',
                    acceptanceCriteria: [{ value: '' }],
                  })}
                >
                  + Add PBI
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bdp-modal-footer">
          {step === 'input' && (
            <>
              <button className="btn-cancel" onClick={onCancel}>Cancel</button>
              <button
                className="btn-generate-pbi-confirm"
                onClick={promptForm.handleSubmit(handleGenerate)}
              >
                ✦ Generate
              </button>
            </>
          )}
          {step === 'generating' && (
            <button className="btn-cancel" disabled>Cancel</button>
          )}
          {step === 'review' && reviewMode === 'view' && (
            <>
              <button className="btn-cancel" onClick={() => setStep('input')} disabled={isSaving}>
                ← Regenerate
              </button>
              <button className="btn-edit" onClick={() => setReviewMode('edit')} disabled={isSaving}>
                ✎ Edit
              </button>
              <button
                className="btn-generate-pbi-confirm"
                onClick={reviewForm.handleSubmit(handleAddToBacklog)}
                disabled={isSaving}
              >
                {isSaving ? 'Adding…' : '✓ Add to Backlog'}
              </button>
            </>
          )}
          {step === 'review' && reviewMode === 'edit' && (
            <>
              <button className="btn-cancel" onClick={() => setReviewMode('view')} disabled={isSaving}>
                ← Back to Review
              </button>
              <button
                className="btn-generate-pbi-confirm"
                onClick={reviewForm.handleSubmit(handleAddToBacklog)}
                disabled={isSaving}
              >
                {isSaving ? 'Adding…' : '✓ Add to Backlog'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ── Generate PBI Modal ──────────────────────────────────── */

const generatePBISchema = z.object({
  userRequest: z.string().min(10, 'Please provide at least 10 characters describing the PBI'),
});
type GeneratePBIFormValues = z.infer<typeof generatePBISchema>;

const reviewPBISchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(1, 'Description is required'),
  priority: z.string(),
  confidence: z.string(),
  tags: z.string(),
  acceptanceCriteria: z.array(z.object({ value: z.string() })),
});
type ReviewPBIFormValues = z.infer<typeof reviewPBISchema>;

const GeneratePBIModal: React.FC<GeneratePBIModalProps> = ({
  feature,
  document,
  isSaving,
  onConfirm,
  onCancel,
}) => {
  const [step, setStep] = useState<'input' | 'generating' | 'review'>('input');
  const [reviewMode, setReviewMode] = useState<'view' | 'edit'>('view');
  const [generateError, setGenerateError] = useState<string | null>(null);

  /* ── Step 1: prompt form ── */
  const promptForm = useForm<GeneratePBIFormValues>({
    resolver: zodResolver(generatePBISchema),
    defaultValues: { userRequest: '' },
  });

  /* ── Step 2: review / edit form ── */
  const reviewForm = useForm<ReviewPBIFormValues>({
    resolver: zodResolver(reviewPBISchema),
    defaultValues: {
      title: '',
      description: '',
      priority: 'Medium',
      confidence: 'Medium',
      tags: '',
      acceptanceCriteria: [],
    },
  });

  const {
    fields: acFields,
    append: appendAC,
    remove: removeAC,
  } = useFieldArray<ReviewPBIFormValues, 'acceptanceCriteria', 'id'>({
    control: reviewForm.control,
    name: 'acceptanceCriteria',
  });

  // Reactive snapshot of the review form — used by the read-only view
  const reviewed = reviewForm.watch();

  const handleGenerate = async (values: GeneratePBIFormValues) => {
    setStep('generating');
    setGenerateError(null);
    try {
      const res = await fetch('/api/backlog/generate-pbi', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureId: feature.id,
          document,
          userRequest: values.userRequest,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `Generation failed: ${res.status}`);
      }
      const data = (await res.json()) as GeneratedPBIData;

      reviewForm.reset({
        title: data.title,
        description: data.description,
        priority: data.priority || 'Medium',
        confidence: data.confidence || 'Medium',
        tags: (data.tags ?? []).join(', '),
        acceptanceCriteria: (data.acceptanceCriteria ?? []).map(v => ({ value: v })),
      });

      setReviewMode('view');
      setStep('review');
    } catch (err: any) {
      setGenerateError(err.message ?? 'Generation failed');
      setStep('input');
    }
  };

  const handleAddToBacklog = (values: ReviewPBIFormValues) => {
    const tags = values.tags
      ? values.tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const ac = (values.acceptanceCriteria ?? [])
      .map(item => item.value)
      .filter(Boolean);
    onConfirm({
      title: values.title,
      description: values.description,
      priority: values.priority,
      confidence: values.confidence,
      tags,
      acceptanceCriteria: ac,
    });
  };

  // Derived display values for the read-only card
  const viewTags = reviewed.tags
    ? reviewed.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const viewAC = (reviewed.acceptanceCriteria ?? [])
    .map(item => item.value)
    .filter(Boolean);
  const priorityClass = PRIORITY_COLORS[reviewed.priority ?? ''] ?? '';

  const { register: registerReview, formState: { errors: reviewErrors } } = reviewForm;

  /* ── header title ── */
  const headerTitle =
    step === 'review'
      ? reviewMode === 'edit' ? 'Edit PBI' : 'Review Generated PBI'
      : 'Generate PBI';

  return (
    <div
      className="bdp-modal-overlay"
      onClick={step === 'generating' || isSaving ? undefined : onCancel}
    >
      <div className="bdp-modal bdp-modal--generate" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="bdp-modal-header">
          <div className="bdp-modal-header-left">
            <h3 className="bdp-modal-title">{headerTitle}</h3>
            {step === 'review' && (
              <span className="bdp-gen-ai-badge">✦ AI generated</span>
            )}
          </div>
          <button
            className="bdp-modal-close"
            onClick={onCancel}
            disabled={step === 'generating' || isSaving}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="bdp-modal-body bdp-modal-body--scrollable">

          {/* Feature context pill — always visible */}
          <div className="bdp-gen-feature-context">
            <span className="bdp-type-chip type-feature" style={{ fontSize: '10px', padding: '1px 6px' }}>
              Feature
            </span>
            <span className="bdp-gen-feature-title">{feature.title}</span>
          </div>

          {/* ── Step 1: prompt input ── */}
          {step === 'input' && (
            <>
              {generateError && (
                <div className="bdp-save-error" role="alert">{generateError}</div>
              )}
              <div className="bdp-gen-input-group">
                <label className="bdp-edit-label" htmlFor="gen-request">
                  Describe what you want this PBI to cover
                </label>
                <textarea
                  id="gen-request"
                  className={`bdp-edit-textarea bdp-gen-textarea${promptForm.formState.errors.userRequest ? ' input-error' : ''}`}
                  rows={5}
                  placeholder={`e.g. "A worker should be able to submit a time-off request for a future date and receive a confirmation"`}
                  {...promptForm.register('userRequest')}
                />
                {promptForm.formState.errors.userRequest && (
                  <span className="bdp-field-error">{promptForm.formState.errors.userRequest.message}</span>
                )}
              </div>
              <p className="bdp-gen-hint">
                AI will generate a user story description and Given/When/Then acceptance criteria matching the format of existing PBIs in this feature.
              </p>
            </>
          )}

          {/* ── Generating spinner ── */}
          {step === 'generating' && (
            <div className="bdp-gen-loading">
              <div className="bdp-gen-spinner" aria-hidden="true" />
              <span>Generating PBI with AI…</span>
            </div>
          )}

          {/* ── Step 2a: read-only review card ── */}
          {step === 'review' && reviewMode === 'view' && (
            <div className="bdp-gen-preview">
              {/* Title */}
              <div className="bdp-gen-preview-section">
                <span className="bdp-edit-label">Title</span>
                <p className="bdp-gen-preview-title">{reviewed.title}</p>
              </div>

              {/* Meta row */}
              <div className="bdp-gen-preview-meta">
                {reviewed.priority && (
                  <span className={`bdp-priority-badge ${priorityClass}`}>
                    {reviewed.priority}
                  </span>
                )}
                {reviewed.confidence && (
                  <span className="bdp-confidence">{reviewed.confidence} confidence</span>
                )}
                {viewTags.map(tag => (
                  <span key={tag} className="bdp-tag">{tag}</span>
                ))}
              </div>

              {/* Description */}
              <div className="bdp-gen-preview-section">
                <span className="bdp-edit-label">Description</span>
                <p className="bdp-gen-preview-body">{reviewed.description}</p>
              </div>

              {/* Acceptance Criteria */}
              {viewAC.length > 0 && (
                <div className="bdp-gen-preview-section">
                  <span className="bdp-edit-label">Acceptance Criteria</span>
                  <ol className="bdp-ac-list bdp-gen-ac-list">
                    {viewAC.map((ac, i) => (
                      <li key={i} className="bdp-ac-item">{ac}</li>
                    ))}
                  </ol>
                </div>
              )}

              <p className="bdp-gen-draft-note">
                This PBI will be added as <strong>Draft</strong>. Use <strong>✎ Edit</strong> to adjust any details before adding.
              </p>
            </div>
          )}

          {/* ── Step 2b: editable form ── */}
          {step === 'review' && reviewMode === 'edit' && (
            <div className="bdp-edit-form bdp-gen-review-form">

              {/* Title */}
              <div className="bdp-edit-field">
                <label className="bdp-edit-label" htmlFor="review-title">Title</label>
                <input
                  id="review-title"
                  className={`bdp-edit-input${reviewErrors.title ? ' input-error' : ''}`}
                  {...registerReview('title')}
                />
                {reviewErrors.title && (
                  <span className="bdp-field-error">{reviewErrors.title.message}</span>
                )}
              </div>

              {/* Priority + Confidence */}
              <div className="bdp-gen-meta-row">
                <div className="bdp-edit-field bdp-gen-meta-field">
                  <label className="bdp-edit-label" htmlFor="review-priority">Priority</label>
                  <select id="review-priority" className="bdp-edit-select" {...registerReview('priority')}>
                    {PRIORITY_OPTIONS.filter(Boolean).map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
                <div className="bdp-edit-field bdp-gen-meta-field">
                  <label className="bdp-edit-label" htmlFor="review-confidence">Confidence</label>
                  <select id="review-confidence" className="bdp-edit-select" {...registerReview('confidence')}>
                    {CONFIDENCE_OPTIONS.filter(Boolean).map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Tags */}
              <div className="bdp-edit-field">
                <label className="bdp-edit-label" htmlFor="review-tags">Tags (comma-separated)</label>
                <input
                  id="review-tags"
                  className="bdp-edit-input"
                  placeholder="e.g. RTO, Worker, SelfService"
                  {...registerReview('tags')}
                />
              </div>

              {/* Description */}
              <div className="bdp-edit-field">
                <label className="bdp-edit-label" htmlFor="review-description">
                  Description
                  <span className="bdp-gen-field-hint"> — As a [user], I want to […], so that […]</span>
                </label>
                <textarea
                  id="review-description"
                  className={`bdp-edit-textarea${reviewErrors.description ? ' input-error' : ''}`}
                  rows={4}
                  {...registerReview('description')}
                />
                {reviewErrors.description && (
                  <span className="bdp-field-error">{reviewErrors.description.message}</span>
                )}
              </div>

              {/* Acceptance Criteria */}
              <div className="bdp-edit-field">
                <label className="bdp-edit-label">
                  Acceptance Criteria
                  <span className="bdp-gen-field-hint"> — Given […] When […] Then […]</span>
                </label>
                <div className="bdp-ac-edit-list">
                  {(acFields as any[]).map((field, index) => (
                    <div key={field.id} className="bdp-ac-edit-row">
                      <span className="bdp-ac-edit-num">{index + 1}.</span>
                      <textarea
                        className="bdp-edit-textarea bdp-ac-edit-textarea"
                        rows={2}
                        {...registerReview(`acceptanceCriteria.${index}.value`)}
                      />
                      <button
                        type="button"
                        className="btn-ac-remove"
                        onClick={() => removeAC(index)}
                        title="Remove criterion"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn-ac-add"
                    onClick={() => appendAC({ value: '' })}
                  >
                    + Add criterion
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="bdp-modal-footer">
          {step === 'input' && (
            <>
              <button className="btn-cancel" onClick={onCancel}>Cancel</button>
              <button
                className="btn-generate-pbi-confirm"
                onClick={promptForm.handleSubmit(handleGenerate)}
              >
                ✦ Generate
              </button>
            </>
          )}

          {step === 'generating' && (
            <button className="btn-cancel" disabled>Cancel</button>
          )}

          {step === 'review' && reviewMode === 'view' && (
            <>
              <button
                className="btn-cancel"
                onClick={() => setStep('input')}
                disabled={isSaving}
              >
                ← Regenerate
              </button>
              <button
                className="btn-edit"
                onClick={() => setReviewMode('edit')}
                disabled={isSaving}
                title="Edit the generated content"
              >
                ✎ Edit
              </button>
              <button
                className="btn-generate-pbi-confirm"
                onClick={reviewForm.handleSubmit(handleAddToBacklog)}
                disabled={isSaving}
              >
                {isSaving ? 'Adding…' : '✓ Add to Backlog'}
              </button>
            </>
          )}

          {step === 'review' && reviewMode === 'edit' && (
            <>
              <button
                className="btn-cancel"
                onClick={() => setReviewMode('view')}
                disabled={isSaving}
              >
                ← Back to Review
              </button>
              <button
                className="btn-generate-pbi-confirm"
                onClick={reviewForm.handleSubmit(handleAddToBacklog)}
                disabled={isSaving}
              >
                {isSaving ? 'Adding…' : '✓ Add to Backlog'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ── Create PBI ADO Confirm Modal ────────────────────────── */

interface CreatePbiAdoConfirmModalProps {
  pbi: BacklogPBI;
  document: BacklogDocumentPayload;
  isCreating: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const CreatePbiAdoConfirmModal: React.FC<CreatePbiAdoConfirmModalProps> = ({
  pbi,
  document,
  isCreating,
  onConfirm,
  onCancel,
}) => {
  const parentFeature = document.features.find(f => f.id === pbi.parentId);
  const parentEpic = parentFeature ? document.epics.find(e => e.id === parentFeature.parentId) : undefined;

  const featureAlreadyInAdo = !!parentFeature?.adoWorkItemId;

  return (
    <div className="bdp-modal-overlay" onClick={onCancel}>
      <div className="bdp-modal" onClick={e => e.stopPropagation()}>
        <div className="bdp-modal-header">
          <h3 className="bdp-modal-title">Create PBI in Azure DevOps</h3>
          <button className="bdp-modal-close" onClick={onCancel} disabled={isCreating}>✕</button>
        </div>

        <div className="bdp-modal-body">
          <p className="bdp-modal-epic-name">&ldquo;{pbi.title}&rdquo;</p>

          <div className="bdp-modal-info">
            This will create <strong>one Product Backlog Item</strong> in Azure DevOps.
            {!featureAlreadyInAdo && parentFeature && (
              <> The parent Feature &ldquo;{parentFeature.title}&rdquo; will also be created
              {parentEpic?.adoWorkItemId ? ' and linked to its Epic' : ''} since it is not yet in ADO.</>
            )}
          </div>

          <div className="bdp-modal-summary">
            {!featureAlreadyInAdo && parentFeature && (
              <div className="bdp-modal-summary-row">
                <span className="bdp-type-chip type-feature" style={{ fontSize: '10px' }}>Feature</span>
                <span>1 Feature will be created</span>
              </div>
            )}
            <div className="bdp-modal-summary-row">
              <span className="bdp-type-chip type-pbi" style={{ fontSize: '10px' }}>PBI</span>
              <span>1 PBI will be created</span>
            </div>
          </div>

          <p className="bdp-modal-confirm-text">
            Are you sure you want to proceed? This will create live work items in Azure DevOps.
          </p>
        </div>

        <div className="bdp-modal-footer">
          <button className="btn-cancel" onClick={onCancel} disabled={isCreating}>Cancel</button>
          <button className="btn-create-ado-confirm" onClick={onConfirm} disabled={isCreating}>
            {isCreating ? 'Creating…' : '⊕ Create in ADO'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ── Create ADO Confirm Modal ─────────────────────────────── */

interface CreateAdoConfirmModalProps {
  epicTitle: string;
  epicId: string;
  epicStatus: string;
  document: BacklogDocumentPayload;
  isCreating: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const CreateAdoConfirmModal: React.FC<CreateAdoConfirmModalProps> = ({
  epicTitle,
  epicId,
  epicStatus,
  document,
  isCreating,
  onConfirm,
  onCancel,
}) => {
  const isReadyStatus = (s: string) => s === 'Approved' || s === 'Accepted';

  const acceptedFeatures = document.features.filter(f => f.parentId === epicId && isReadyStatus(f.status));
  const acceptedFeatureIds = new Set(acceptedFeatures.map(f => f.id));
  const acceptedPBIs = document.pbis.filter(p => acceptedFeatureIds.has(p.parentId) && isReadyStatus(p.status));

  const epicApproved = epicStatus === 'Approved';
  const hasAcceptedFeature = acceptedFeatures.length > 0;
  const hasAcceptedPBI = acceptedPBIs.length > 0;
  const canCreate = epicApproved && hasAcceptedFeature && hasAcceptedPBI;

  const blockers: { label: string; met: boolean; detail: string }[] = [
    {
      label: 'Epic is Approved',
      met: epicApproved,
      detail: `Current status is "${epicStatus}". Set this Epic to Approved before creating ADO items.`,
    },
    {
      label: 'At least one Approved or Accepted Feature',
      met: hasAcceptedFeature,
      detail: 'At least one child Feature must be set to Approved or Accepted.',
    },
    {
      label: 'At least one Approved or Accepted PBI under a ready Feature',
      met: hasAcceptedPBI,
      detail: 'At least one PBI under an Approved/Accepted Feature must also be Approved or Accepted.',
    },
  ];

  return (
    <div className="bdp-modal-overlay" onClick={onCancel}>
      <div className="bdp-modal" onClick={e => e.stopPropagation()}>
        <div className="bdp-modal-header">
          <h3 className="bdp-modal-title">Create ADO Backlog Items</h3>
          <button className="bdp-modal-close" onClick={onCancel} disabled={isCreating}>✕</button>
        </div>

        <div className="bdp-modal-body">
          <p className="bdp-modal-epic-name">&ldquo;{epicTitle}&rdquo;</p>

          {!canCreate ? (
            <>
              <div className="bdp-modal-blocked-intro">
                The following criteria must be met before ADO work items can be created:
              </div>
              <div className="bdp-modal-criteria-list">
                {blockers.map(b => (
                  <div key={b.label} className={`bdp-modal-criteria-row${b.met ? ' criteria-met' : ' criteria-unmet'}`}>
                    <span className="bdp-criteria-icon">{b.met ? '✓' : '✕'}</span>
                    <div className="bdp-criteria-body">
                      <span className="bdp-criteria-label">{b.label}</span>
                      {!b.met && <span className="bdp-criteria-detail">{b.detail}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="bdp-modal-info">
                Only child items with status <span className="bdp-modal-status-tag">Approved</span> or{' '}
                <span className="bdp-modal-status-tag">Accepted</span> will be included.
                Items still in Draft or Rejected will be skipped.
                Once created, this Epic will be marked <span className="bdp-modal-status-tag bdp-modal-status-merged">Merged</span>.
              </div>

              <div className="bdp-modal-summary">
                <div className="bdp-modal-summary-row">
                  <span className="bdp-type-chip type-epic" style={{ fontSize: '10px' }}>Epic</span>
                  <span>1 Epic will be created</span>
                </div>
                <div className="bdp-modal-summary-row">
                  <span className="bdp-type-chip type-feature" style={{ fontSize: '10px' }}>Feature</span>
                  <span>{acceptedFeatures.length} Feature{acceptedFeatures.length !== 1 ? 's' : ''} ready</span>
                </div>
                <div className="bdp-modal-summary-row">
                  <span className="bdp-type-chip type-pbi" style={{ fontSize: '10px' }}>PBI</span>
                  <span>{acceptedPBIs.length} PBI{acceptedPBIs.length !== 1 ? 's' : ''} ready</span>
                </div>
              </div>

              <p className="bdp-modal-confirm-text">
                Are you sure you want to proceed? This will create live work items in Azure DevOps.
              </p>
            </>
          )}
        </div>

        <div className="bdp-modal-footer">
          <button className="btn-cancel" onClick={onCancel} disabled={isCreating}>
            {canCreate ? 'Cancel' : 'Close'}
          </button>
          {canCreate && (
            <button className="btn-create-ado-confirm" onClick={onConfirm} disabled={isCreating}>
              {isCreating ? 'Creating…' : '⊕ Create in ADO'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ── Unlink ADO Confirm Modal ─────────────────────────────── */

interface UnlinkAdoConfirmModalProps {
  node: BacklogNode;
  adoId: number;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const UnlinkAdoConfirmModal: React.FC<UnlinkAdoConfirmModalProps> = ({
  node,
  adoId,
  isDeleting,
  onConfirm,
  onCancel,
}) => (
  <div className="bdp-modal-overlay" onClick={onCancel}>
    <div className="bdp-modal" onClick={e => e.stopPropagation()}>
      <div className="bdp-modal-header">
        <h3 className="bdp-modal-title">Delete ADO Work Item</h3>
        <button className="bdp-modal-close" onClick={onCancel} disabled={isDeleting}>✕</button>
      </div>

      <div className="bdp-modal-body">
        <p className="bdp-modal-epic-name">&ldquo;{node.title}&rdquo;</p>
        <div className="bdp-modal-info">
          This will <strong>permanently delete</strong> {node.workItemType} #{adoId} from Azure DevOps
          and reset this item&apos;s status back to <strong>Draft</strong>.
        </div>
        <p className="bdp-modal-confirm-text bdp-modal-confirm-text--danger">
          This action cannot be undone. Are you sure you want to proceed?
        </p>
      </div>

      <div className="bdp-modal-footer">
        <button className="btn-cancel" onClick={onCancel} disabled={isDeleting}>Cancel</button>
        <button className="btn-unlink-ado-confirm" onClick={onConfirm} disabled={isDeleting}>
          {isDeleting ? 'Deleting…' : '⊗ Delete from ADO'}
        </button>
      </div>
    </div>
  </div>
);
