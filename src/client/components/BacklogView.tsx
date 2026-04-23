import React, { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BacklogDocument, BacklogNode } from '../types/workitem';
import { BacklogDetailsPanel } from './BacklogDetailsPanel';
import './BacklogView.css';

interface BacklogViewProps {
  project: string;
  areaPath: string;
}

async function fetchDraftDocs(project: string, areaPath: string): Promise<BacklogDocument[]> {
  const res = await fetch(
    `/api/backlog/drafts?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`,
    { credentials: 'include' }
  );
  if (!res.ok) throw new Error(`Failed to fetch backlog drafts: ${res.status}`);
  return res.json();
}

const TYPE_LABELS: Record<string, string> = {
  Epic: 'Epic',
  Feature: 'Feature',
  PBI: 'PBI',
};

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'status-draft',
  Approved: 'status-approved',
  Accepted: 'status-accepted',
  Merged: 'status-merged',
  Rejected: 'status-rejected',
};

function findNodeInDoc(doc: BacklogDocument, id: string): BacklogNode | null {
  return (
    doc.document.epics.find(n => n.id === id) ??
    doc.document.features.find(n => n.id === id) ??
    doc.document.pbis.find(n => n.id === id) ??
    null
  );
}


const BacklogView: React.FC<BacklogViewProps> = ({ project, areaPath }) => {
  const queryClient = useQueryClient();

  const { data: docs = [], isLoading, isError, error } = useQuery<BacklogDocument[]>({
    queryKey: ['backlog-drafts', project, areaPath],
    queryFn: () => fetchDraftDocs(project, areaPath),
    staleTime: 5 * 60 * 1000,
  });

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Map every node id → its parent document so the details panel gets the right doc/path
  const nodeToDoc = useMemo(() => {
    const map = new Map<string, BacklogDocument>();
    docs.forEach(doc => {
      doc.document.epics.forEach(n => map.set(n.id, doc));
      doc.document.features.forEach(n => map.set(n.id, doc));
      doc.document.pbis.forEach(n => map.set(n.id, doc));
    });
    return map;
  }, [docs]);

  const selectedDoc = selectedNodeId ? (nodeToDoc.get(selectedNodeId) ?? null) : null;

  const selectedNode: BacklogNode | null = useMemo(() => {
    if (!selectedNodeId || !selectedDoc) return null;
    return findNodeInDoc(selectedDoc, selectedNodeId);
  }, [selectedNodeId, selectedDoc]);

  // Totals across all documents
  const totals = useMemo(() => ({
    epics: docs.reduce((s, d) => s + d.document.epics.length, 0),
    features: docs.reduce((s, d) => s + d.document.features.length, 0),
    pbis: docs.reduce((s, d) => s + d.document.pbis.length, 0),
  }), [docs]);

  // All expand keys across all documents (for expand-all / collapse-all).
  const allExpandKeys = useMemo(() => {
    const keys: string[] = [];
    docs.forEach((doc, di) => {
      doc.document.epics.forEach((_e, ei) => keys.push(`${di}:${ei}`));
      doc.document.features.forEach((_f, fi) => keys.push(`${di}:f${fi}`));
    });
    return keys;
  }, [docs]);  // (also used by handleExpandAll / handleCollapseAll)

  // Assign features → epics and PBIs → features using index-based keys so that
  // duplicate or missing IDs never cause one epic to absorb another's children.
  // Each feature/PBI is claimed by the FIRST epic/feature whose id matches.
  const childMap = useMemo(() => {
    type Feat = typeof docs[0]['document']['features'][0];
    type Pbi  = typeof docs[0]['document']['pbis'][0];
    const epicFeats  = new Map<string, Feat[]>();  // key: `${di}:${ei}`
    const featPbis   = new Map<string, Pbi[]>();   // key: `${di}:f${fi_global}`

    docs.forEach((doc, di) => {
      const claimedFeats = new Set<number>();
      doc.document.epics.forEach((epic, ei) => {
        const feats: Feat[] = [];
        doc.document.features.forEach((feat, fi) => {
          if (!claimedFeats.has(fi) && String(feat.parentId) === String(epic.id)) {
            feats.push(feat);
            claimedFeats.add(fi);
          }
        });
        epicFeats.set(`${di}:${ei}`, feats);
      });

      const claimedPbis = new Set<number>();
      doc.document.features.forEach((feat, fi) => {
        const pbis: Pbi[] = [];
        doc.document.pbis.forEach((pbi, pi) => {
          if (!claimedPbis.has(pi) && String(pbi.parentId) === String(feat.id)) {
            pbis.push(pbi);
            claimedPbis.add(pi);
          }
        });
        featPbis.set(`${di}:f${fi}`, pbis);
      });
    });

    return { epicFeats, featPbis };
  }, [docs]);

  const handleExpandAll = () => setExpandedIds(new Set(allExpandKeys));
  const handleCollapseAll = () => setExpandedIds(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectNode = (node: BacklogNode) => setSelectedNodeId(node.id);
  const handleClosePanel = () => setSelectedNodeId(null);

  if (isLoading) {
    return (
      <div className="backlog-view-container">
        <div className="backlog-loading">
          <div className="backlog-spinner"></div>
          <span>Loading draft backlog documents...</span>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="backlog-view-container">
        <div className="backlog-error">
          <span>Failed to load backlog drafts: {(error as Error).message}</span>
          <button
            className="btn-retry"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="backlog-view-container">
        <div className="backlog-header">
          <div className="backlog-header-left">
            <h2>Backlog</h2>
            <span className="backlog-subtitle">Draft Requirements</span>
          </div>
          <button
            className="btn-refresh"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] })}
          >
            ↺ Refresh
          </button>
        </div>
        <div className="backlog-empty">
          <div className="empty-icon">📋</div>
          <div className="empty-title">No draft backlog documents found</div>
          <div className="empty-hint">
            Create wiki subpages under <code>/requirement-drafts</code> with an embedded{' '}
            <code>```json</code> block containing an <code>epics</code> array.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="backlog-view-container">
      <div className="backlog-header">
        <div className="backlog-header-left">
          <h2>Backlog</h2>
          <span className="backlog-subtitle">Draft Requirements</span>
        </div>
        <button
          className="btn-refresh"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] })}
        >
          ↺ Refresh
        </button>
      </div>

      <div className="backlog-content">
        <div className="backlog-toolbar">
          <div className="backlog-counts">
            <span className="count-chip chip-epic">{totals.epics} Epic{totals.epics !== 1 ? 's' : ''}</span>
            <span className="count-chip chip-feature">{totals.features} Feature{totals.features !== 1 ? 's' : ''}</span>
            <span className="count-chip chip-pbi">{totals.pbis} PBI{totals.pbis !== 1 ? 's' : ''}</span>
          </div>
          <div className="backlog-toolbar-actions">
            <button className="btn-expand-all" onClick={handleExpandAll}>Expand All</button>
            <button className="btn-collapse-all" onClick={handleCollapseAll}>Collapse All</button>
          </div>
        </div>

        <div className="backlog-tree">
          {docs.map((doc, docIdx) => (
            <React.Fragment key={doc.id}>
              {docs.length > 1 && (
                <div className="backlog-doc-section-header">
                  <span className="backlog-doc-section-title">{doc.title}</span>
                </div>
              )}
              {doc.document.epics.map((epic, epicIdx) => {
                const epicKey    = `${docIdx}:${epicIdx}`;
                const epicFeatures = childMap.epicFeats.get(epicKey) ?? [];
                const epicExpanded = expandedIds.has(epicKey);

                return (
                  <div key={epicKey} className={`tree-epic-group${docIdx > 0 ? ' tree-epic-group--subsequent' : ''}`}>
                    <BacklogTreeRow
                      node={epic}
                      depth={0}
                      isExpanded={epicExpanded}
                      hasChildren={epicFeatures.length > 0}
                      isSelected={selectedNodeId === epic.id}
                      onToggle={() => toggleExpand(epicKey)}
                      onSelect={() => handleSelectNode(epic)}
                    />

                    {epicExpanded && epicFeatures.map((feature) => {
                      const featGlobalIdx = doc.document.features.indexOf(feature);
                      const featureKey   = `${docIdx}:f${featGlobalIdx}`;
                      const featurePBIs  = childMap.featPbis.get(featureKey) ?? [];
                      const featureExpanded = expandedIds.has(featureKey);

                      return (
                        <div key={featureKey} className="tree-feature-group">
                          <BacklogTreeRow
                            node={feature}
                            depth={1}
                            isExpanded={featureExpanded}
                            hasChildren={featurePBIs.length > 0}
                            isSelected={selectedNodeId === feature.id}
                            onToggle={() => toggleExpand(featureKey)}
                            onSelect={() => handleSelectNode(feature)}
                          />

                          {featureExpanded && featurePBIs.map((pbi, pbiIdx) => (
                            <BacklogTreeRow
                              key={`${featureKey}:p${pbiIdx}`}
                              node={pbi}
                              depth={2}
                              isExpanded={false}
                              hasChildren={false}
                              isSelected={selectedNodeId === pbi.id}
                              onToggle={() => {}}
                              onSelect={() => handleSelectNode(pbi)}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>


      {selectedNode && selectedDoc && (
        <BacklogDetailsPanel
          node={selectedNode}
          document={selectedDoc.document}
          pagePath={selectedDoc.path}
          project={project}
          areaPath={areaPath}
          onClose={handleClosePanel}
          onSelectNode={handleSelectNode}
        />
      )}

    </div>
  );
};

interface TreeRowProps {
  node: BacklogNode;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  isSelected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

const BacklogTreeRow: React.FC<TreeRowProps> = ({
  node,
  depth,
  isExpanded,
  hasChildren,
  isSelected,
  onToggle,
  onSelect,
}) => {
  const typeClass = node.workItemType.toLowerCase();
  const statusClass = STATUS_CLASSES[node.status] ?? 'status-draft';

  return (
    <div
      className={`tree-row tree-row-depth-${depth} type-${typeClass}${isSelected ? ' tree-row-selected' : ''}`}
      style={{ paddingLeft: `${12 + depth * 24}px` }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(); }}
    >
      <span
        className={`tree-chevron${hasChildren ? ' tree-chevron-visible' : ''}`}
        onClick={e => { e.stopPropagation(); if (hasChildren) onToggle(); }}
        role={hasChildren ? 'button' : undefined}
        aria-expanded={hasChildren ? isExpanded : undefined}
      >
        {hasChildren ? (isExpanded ? '▾' : '▸') : ''}
      </span>

      <span className={`type-chip chip-${typeClass}`}>
        {TYPE_LABELS[node.workItemType] ?? node.workItemType}
      </span>

      <span className="tree-row-id">{node.id}</span>

      <span className="tree-row-title">{node.title}</span>

      <div className="tree-row-meta">
        {node.status && (
          <span className={`status-badge-backlog ${statusClass}`}>
            {node.status.charAt(0).toUpperCase() + node.status.slice(1)}
          </span>
        )}
        {(node as any).adoWorkItemId && (node as any).adoWorkItemUrl && (
          <a
            className="tree-ado-badge"
            href={(node as any).adoWorkItemUrl as string}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            title={`View ${node.workItemType} #${(node as any).adoWorkItemId} in Azure DevOps`}
          >
            ADO #{(node as any).adoWorkItemId} ↗
          </a>
        )}
      </div>
    </div>
  );
};

export default BacklogView;
