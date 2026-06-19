import React, { useRef, useEffect, useState, useCallback } from 'react';
import styles from './BoundaryEditor.module.css';

interface BoundaryEditorProps {
  html: string;
  featureName: string;
  onSave: (updatedHtml: string) => void;
  onCancel: () => void;
  isSaving: boolean;
}

const SELECTED_ATTR = 'data-nf-selected';

function injectEditorScript(): string {
  return `
<style>
  [${SELECTED_ATTR}] {
    outline: 3px dashed #a46bff !important;
    outline-offset: 2px;
    background: rgba(164, 107, 255, 0.06) !important;
  }
  .nf-hover {
    outline: 2px solid #3363f5 !important;
    outline-offset: 2px;
    cursor: pointer;
  }
</style>
<script>
(function() {
  var hovered = null;
  var lastClicked = null;

  function leaf(el) {
    while (el && el !== document.body && el.tagName !== 'HTML') {
      if (el.nodeType === 1) return el;
      el = el.parentNode;
    }
    return null;
  }

  function clearSelection() {
    var prev = document.querySelectorAll('[${SELECTED_ATTR}]');
    for (var i = 0; i < prev.length; i++) prev[i].removeAttribute('${SELECTED_ATTR}');
  }

  function selectedEls() { return document.querySelectorAll('[${SELECTED_ATTR}]'); }
  function firstSelected() { return document.querySelector('[${SELECTED_ATTR}]'); }

  function closest(el, tags) {
    var n = el;
    while (n && n !== document.body) {
      if (tags.indexOf(n.tagName) !== -1) return n;
      n = n.parentElement;
    }
    return null;
  }

  // Climb to the container that holds the grid (substantially larger than the cell)
  function gridScope(el) {
    var cr = el.getBoundingClientRect();
    var n = el.parentElement;
    var last = el;
    while (n && n !== document.body) {
      var r = n.getBoundingClientRect();
      // The grid container is clearly taller than a single cell (multiple rows)
      if (r.height > cr.height * 2 && r.width > cr.width) return n;
      last = n;
      n = n.parentElement;
    }
    return last.parentElement || document.body;
  }

  function depthFrom(el, scope) {
    var d = 0, n = el;
    while (n && n !== scope && n.parentElement) { d++; n = n.parentElement; }
    return d;
  }

  // Geometry-based aligned-cell finder for non-table grids (div/flex/css-grid).
  // Selects peer cells at the SAME structural depth that are aligned on the axis.
  // axis 'col' → vertically-aligned (same column); 'row' → horizontally-aligned.
  function alignedCells(clicked, axis) {
    var scope = gridScope(clicked);
    var targetDepth = depthFrom(clicked, scope);
    var cr = clicked.getBoundingClientRect();
    var ccx = cr.left + cr.width / 2, ccy = cr.top + cr.height / 2;
    var all = scope.querySelectorAll('*');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (depthFrom(el, scope) !== targetDepth) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (axis === 'col') {
        var cx = r.left + r.width / 2;
        if (Math.abs(cx - ccx) <= Math.max(cr.width * 0.5, 8)) out.push(el);
      } else {
        var cy = r.top + r.height / 2;
        if (Math.abs(cy - ccy) <= Math.max(cr.height * 0.5, 8)) out.push(el);
      }
    }
    if (out.indexOf(clicked) === -1) out.push(clicked);
    return out;
  }

  function setSelection(els, scroll, additive) {
    if (!additive) clearSelection();
    for (var i = 0; i < els.length; i++) {
      if (els[i] && els[i] !== document.body) {
        els[i].setAttribute('${SELECTED_ATTR}', 'true');
        els[i].classList.remove('nf-hover');
      }
    }
    if (scroll && els[0]) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    notify();
  }

  function notify() {
    var sel = selectedEls();
    var label = null;
    if (sel.length === 1) {
      var s = sel[0];
      label = s.tagName.toLowerCase();
      if (s.id) label += '#' + s.id;
    } else if (sel.length > 1) {
      label = sel.length + ' elements';
    }
    window.parent.postMessage({ type: 'nf-changed', count: sel.length, label: label }, '*');
  }

  function init() {
    var target = null;
    var all = document.body.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var st = (all[i].getAttribute('style') || '');
      if (/dashed[^;]*#a46bff/i.test(st) || /#a46bff[^;]*dashed/i.test(st)) { target = all[i]; break; }
    }
    if (target) {
      var s2 = target.getAttribute('style') || '';
      s2 = s2.replace(/border\\s*:[^;]*#a46bff[^;]*(;|$)/gi, '').replace(/^\\s*;+|;+\\s*$/g, '').trim();
      if (s2) target.setAttribute('style', s2); else target.removeAttribute('style');
      var lbls = target.querySelectorAll('span');
      for (var j = 0; j < lbls.length; j++) if (/^NEW:/i.test(lbls[j].textContent || '')) lbls[j].remove();
      target.setAttribute('${SELECTED_ATTR}', 'true');
    }
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    var rm = [];
    while (walker.nextNode()) if (/NEW_FEATURE:(START|END)/i.test(walker.currentNode.textContent || '')) rm.push(walker.currentNode);
    rm.forEach(function(n){ n.remove(); });
    notify();
  }

  document.addEventListener('DOMContentLoaded', init);

  document.addEventListener('mouseover', function(e) {
    var el = leaf(e.target);
    if (!el) return;
    if (hovered && hovered !== el) hovered.classList.remove('nf-hover');
    if (!el.hasAttribute('${SELECTED_ATTR}')) el.classList.add('nf-hover');
    hovered = el;
  }, true);

  document.addEventListener('mouseout', function() {
    if (hovered) { hovered.classList.remove('nf-hover'); hovered = null; }
  }, true);

  document.addEventListener('click', function(e) {
    e.preventDefault(); e.stopPropagation();
    var el = leaf(e.target);
    if (!el) return;
    lastClicked = el;
    if (e.ctrlKey || e.metaKey) {
      // Toggle this element in/out of the current selection
      if (el.hasAttribute('${SELECTED_ATTR}')) el.removeAttribute('${SELECTED_ATTR}');
      else setSelection([el], false, true);
      notify();
    } else {
      setSelection([el], false);
    }
  }, true);

  window.addEventListener('message', function(e) {
    var d = e.data || {};
    // Anchor row/column ops on the most recently clicked cell so users can
    // build up multiple columns (e.g. Wed then Fri) one at a time.
    var anchor = (lastClicked && lastClicked.hasAttribute('${SELECTED_ATTR}')) ? lastClicked : firstSelected();
    var sel = firstSelected();
    if (d.type === 'nf-expand') {
      if (sel && sel.parentElement && sel.parentElement !== document.body) setSelection([sel.parentElement], true);
    } else if (d.type === 'nf-shrink') {
      if (sel && sel.firstElementChild) setSelection([sel.firstElementChild], true);
    } else if (d.type === 'nf-select-row') {
      if (anchor) {
        var tr = closest(anchor, ['TR']);
        if (tr) {
          setSelection([tr], true, true); // semantic table row
        } else {
          var rowCells = alignedCells(anchor, 'row'); // div/flex/grid row
          if (rowCells.length > 0) setSelection(rowCells, true, true);
        }
      }
    } else if (d.type === 'nf-select-column') {
      if (anchor) {
        var cell = closest(anchor, ['TD', 'TH']);
        var table = closest(anchor, ['TABLE']);
        var cells = [];
        if (cell && table) {
          var colIdx = cell.cellIndex;
          var rows = table.querySelectorAll('tr');
          for (var r = 0; r < rows.length; r++) {
            var cc = rows[r].cells ? rows[r].cells[colIdx] : null;
            if (cc) cells.push(cc);
          }
        }
        // Fall back to geometry when not a table or the semantic match is too small
        if (cells.length < 2) cells = alignedCells(anchor, 'col');
        if (cells.length > 0) setSelection(cells, true, true);
      }
    } else if (d.type === 'nf-clear') {
      clearSelection(); notify();
    }
  });
})();
</script>`;
}

function buildFromDom(iframeDoc: Document, featureName: string): string {
  const docClone = iframeDoc.documentElement.cloneNode(true) as HTMLElement;

  docClone.querySelectorAll('script').forEach(s => s.remove());
  docClone.querySelectorAll('style').forEach(s => {
    if ((s.textContent ?? '').includes(SELECTED_ATTR)) s.remove();
  });
  docClone.querySelectorAll('.nf-hover').forEach(el => el.classList.remove('nf-hover'));

  const selected = Array.from(docClone.querySelectorAll(`[${SELECTED_ATTR}]`)) as HTMLElement[];
  if (selected.length === 0) return '<!DOCTYPE html>\n' + docClone.outerHTML;

  // Border every selected element in place
  for (const el of selected) {
    el.removeAttribute(SELECTED_ATTR);
    const existing = el.getAttribute('style') || '';
    if (!existing.includes('#a46bff')) {
      el.setAttribute('style', existing + (existing && !existing.trim().endsWith(';') ? ';' : '') + 'border:2px dashed #a46bff;');
    }
  }

  // Wrap EACH selected element with its own NEW_FEATURE:START/END marker pair.
  // This keeps extraction precise for non-contiguous selections (e.g. Wed + Fri
  // columns) instead of marking everything between them via a common ancestor.
  selected.forEach((el, idx) => {
    if (!el.parentNode) return;
    const parent = el.parentNode;
    parent.insertBefore(docClone.ownerDocument.createComment(' NEW_FEATURE:START '), el);
    // A single label on the first selected element identifies the feature without
    // disrupting table/grid layout for the remaining cells.
    if (idx === 0) {
      const label = docClone.ownerDocument.createElement('span');
      label.setAttribute('style',
        'display:inline-block;background:#a46bff;color:#fff;font-size:10px;font-weight:700;' +
        'padding:2px 6px;border-radius:2px;margin-bottom:4px;');
      label.textContent = `NEW: ${featureName}`;
      el.insertBefore(label, el.firstChild);
    }
    if (el.nextSibling) parent.insertBefore(docClone.ownerDocument.createComment(' NEW_FEATURE:END '), el.nextSibling);
    else parent.appendChild(docClone.ownerDocument.createComment(' NEW_FEATURE:END '));
  });

  return '<!DOCTYPE html>\n' + docClone.outerHTML;
}

const BoundaryEditor: React.FC<BoundaryEditorProps> = ({ html, featureName, onSave, onCancel, isSaving }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [count, setCount] = useState(0);
  const [selectionLabel, setSelectionLabel] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const preparedHtml = html.replace(/<\/body>/i, `${injectEditorScript()}\n</body>`);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'nf-changed') {
        setCount(e.data.count ?? 0);
        setSelectionLabel(e.data.label ?? null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const post = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  const handleSave = useCallback(() => {
    if (!iframeRef.current?.contentDocument) {
      alert('Editor not ready yet. Please wait for the prototype to load.');
      return;
    }
    try {
      const updatedHtml = buildFromDom(iframeRef.current.contentDocument, featureName);
      if (!updatedHtml.includes('<!DOCTYPE') || !/<\/body>/i.test(updatedHtml)) {
        alert('Error: generated HTML is invalid. Please try again or cancel.');
        return;
      }
      onSave(updatedHtml);
    } catch (err) {
      console.error('[BoundaryEditor] save failed:', err);
      alert('Failed to build the updated prototype: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, [featureName, onSave]);

  const hasSelection = count > 0;

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.toolbarTitle}>Mark the New Feature</span>
          <span className={styles.toolbarHint}>
            Click a cell, then Select Row / Select Column to capture it. To add another column (e.g. Fri after
            Wed), Ctrl/Cmd-click a cell in the next column and press Select Column again. Plain click starts over.
            {hasSelection && selectionLabel ? ` Selected: ${selectionLabel}` : ' Nothing selected yet.'}
          </span>
        </div>
        <div className={styles.toolbarRight}>
          <button type="button" className={styles.adjustBtn} onClick={() => post({ type: 'nf-select-row' })} disabled={!hasSelection}>
            Select Row
          </button>
          <button type="button" className={styles.adjustBtn} onClick={() => post({ type: 'nf-select-column' })} disabled={!hasSelection}>
            Select Column
          </button>
          <button type="button" className={styles.adjustBtn} onClick={() => post({ type: 'nf-expand' })} disabled={!hasSelection}>
            Expand
          </button>
          <button type="button" className={styles.adjustBtn} onClick={() => post({ type: 'nf-shrink' })} disabled={!hasSelection}>
            Shrink
          </button>
          <button type="button" className={styles.adjustBtn} onClick={() => post({ type: 'nf-clear' })} disabled={!hasSelection}>
            Clear
          </button>
          <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className={styles.saveBtn} onClick={handleSave} disabled={isSaving || !hasSelection}>
            {isSaving ? 'Saving…' : 'Save Boundary'}
          </button>
        </div>
      </div>
      <div className={styles.iframeWrapper}>
        <iframe
          ref={iframeRef}
          className={styles.iframe}
          srcDoc={preparedHtml}
          sandbox="allow-same-origin allow-scripts"
          title="Boundary editor"
          onLoad={() => setReady(true)}
        />
        {!ready && <div className={styles.loadingOverlay}>Loading prototype…</div>}
      </div>
    </div>
  );
};

export default BoundaryEditor;
