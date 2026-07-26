/**
 * Ensures AnnotationLayer paints inline <mark> highlights for open comments
 * and restores them after React replaces the document DOM (the failure mode
 * Design Doc scrollspy / markdown remounts hit). Shared by PRD, ADR, and
 * design-doc review — all three mount this same component.
 */

import { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AnnotationLayer } from '../AnnotationLayer';
import type { ReviewCommentWithReplies } from '../../../shared/types/reviewComments';

function makeComment(
  overrides: Partial<ReviewCommentWithReplies> & { exact: string; start: number },
): ReviewCommentWithReplies {
  const { exact, start, ...rest } = overrides;
  return {
    id: rest.id ?? 'c1',
    documentId: 'doc-1',
    documentType: 'design_doc',
    sectionKey: rest.sectionKey ?? 'design',
    authorUserId: 'u1',
    body: 'Needs clarification',
    selector: {
      exact,
      prefix: '',
      suffix: '',
      start,
      end: start + exact.length,
    },
    status: rest.status ?? 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    replies: [],
    ...rest,
  };
}

describe('AnnotationLayer highlights', () => {
  it('wraps matching open-comment text in a mark', async () => {
    const exact = 'highlighted span';
    const body = `Before ${exact} after.`;
    const comment = makeComment({ exact, start: body.indexOf(exact) });

    render(
      <AnnotationLayer
        sectionKey="design"
        comments={[comment]}
        activeCommentId={null}
        onAddComment={jest.fn()}
        onCommentClick={jest.fn()}
      >
        <p>{body}</p>
      </AnnotationLayer>,
    );

    await waitFor(() => {
      const mark = document.querySelector('mark[data-comment-id="c1"]');
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe(exact);
    });
  });

  it('does not highlight resolved comments', async () => {
    const exact = 'resolved span';
    const body = `Before ${exact} after.`;
    const comment = makeComment({
      id: 'resolved-1',
      exact,
      start: body.indexOf(exact),
      status: 'resolved',
    });

    render(
      <AnnotationLayer
        sectionKey="prd"
        comments={[comment]}
        activeCommentId={null}
        onAddComment={jest.fn()}
        onCommentClick={jest.fn()}
      >
        <p>{body}</p>
      </AnnotationLayer>,
    );

    await waitFor(() => {
      expect(screen.getByText(body, { exact: false })).toBeInTheDocument();
    });
    expect(document.querySelector('mark[data-comment-id="resolved-1"]')).toBeNull();
  });

  it('re-applies highlights after children remount (markdown re-render)', async () => {
    const exact = 'stable phrase';
    const comment = makeComment({
      id: 'c-remount',
      exact,
      start: `Intro ${exact} outro`.indexOf(exact),
      sectionKey: 'adr',
    });

    function Harness() {
      const [nonce, setNonce] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setNonce((n) => n + 1)}>
            Remount
          </button>
          <AnnotationLayer
            sectionKey="adr"
            comments={[comment]}
            activeCommentId={null}
            onAddComment={jest.fn()}
            onCommentClick={jest.fn()}
          >
            <p key={nonce}>{`Intro ${exact} outro`}</p>
          </AnnotationLayer>
        </>
      );
    }

    render(<Harness />);

    await waitFor(() => {
      expect(document.querySelector('mark[data-comment-id="c-remount"]')).not.toBeNull();
    });

    await act(async () => {
      screen.getByRole('button', { name: 'Remount' }).click();
    });

    await waitFor(() => {
      expect(document.querySelector('mark[data-comment-id="c-remount"]')).not.toBeNull();
      expect(document.querySelector('mark[data-comment-id="c-remount"]')?.textContent).toBe(exact);
    });
  });
});
