import {
  documentProjectForSwitch,
  documentProjectSwitchTarget,
  parseDocumentDeepLink,
  shouldHoldDocumentRoute,
} from '../documentProjectDeepLink';

describe('document project deep links', () => {
  it('reads an ADR id and ignores the list and compose routes', () => {
    expect(parseDocumentDeepLink('/adr/a9272fb9-0d59-4881-85f2-181f35c249b0')).toEqual({
      kind: 'adr',
      id: 'a9272fb9-0d59-4881-85f2-181f35c249b0',
      guardedView: 'adr',
    });
    expect(parseDocumentDeepLink('/adr')).toBeNull();
    expect(parseDocumentDeepLink('/adr/new')).toBeNull();
  });

  it('reads interview, PRD, design, prototype, and plan links', () => {
    expect(parseDocumentDeepLink('/backlog/interview/int-1')?.kind).toBe('interview');
    expect(parseDocumentDeepLink('/backlog/prd/prd-1')?.guardedView).toBe('backlog');
    expect(parseDocumentDeepLink('/backlog/design-doc/doc-1')?.id).toBe('doc-1');
    expect(parseDocumentDeepLink('/backlog/design-prototypes/prd-1')?.kind).toBe('design-prototype');
    expect(parseDocumentDeepLink('/backlog/design-prototype/prd-1')?.kind).toBe('design-prototype');
    expect(parseDocumentDeepLink('/backlog/design-plan/prd-1')?.kind).toBe('design-plan');
  });

  it('reads record links that carry the id in the query string', () => {
    expect(parseDocumentDeepLink('/feature-requests', '?id=fr-1')).toMatchObject({
      kind: 'feature-request',
      id: 'fr-1',
    });
    expect(parseDocumentDeepLink('/work-board', '?item=item-1')?.kind).toBe('work-item');
    expect(parseDocumentDeepLink('/home', '?thread=thread-1')?.kind).toBe('chat-thread');
    expect(parseDocumentDeepLink('/playbooks', '?project=Apex&run=run-1')?.kind).toBe('playbook-run');
    expect(parseDocumentDeepLink('/standup-summary', '?session=session-1')?.kind).toBe('standup-session');
    expect(parseDocumentDeepLink('/my-work', '?section=backlog&itemId=fr-2')?.id).toBe('fr-2');
    expect(parseDocumentDeepLink('/feature-requests')).toBeNull();
  });

  it('reads diagram, load-test, UI Lab, and dev-session links', () => {
    expect(parseDocumentDeepLink('/diagrams/diagram-1')?.guardedView).toBe('diagrams');
    expect(parseDocumentDeepLink('/diagrams/new')).toBeNull();
    expect(parseDocumentDeepLink('/load-tests/def-1')?.kind).toBe('load-test');
    expect(parseDocumentDeepLink('/load-tests/def-1/runs')?.kind).toBe('load-test');
    expect(parseDocumentDeepLink('/load-tests/runs/run-1')?.kind).toBe('load-test-run');
    expect(parseDocumentDeepLink('/load-tests/new')).toBeNull();
    expect(parseDocumentDeepLink('/ui-lab/design-1')?.kind).toBe('ui-lab');
    expect(parseDocumentDeepLink('/my-work/session/session-1')?.kind).toBe('dev-session');
  });

  it('does not use ?project= when a record lookup failed or is still pending', () => {
    const link = parseDocumentDeepLink('/home', '?thread=thread-1&project=Apex');
    expect(documentProjectForSwitch(link, undefined, 'Apex')).toBeUndefined();
    expect(documentProjectForSwitch(link, 'Nurses', 'Apex')).toBe('Nurses');
  });

  it('keeps ?project= on non-record routes', () => {
    expect(documentProjectForSwitch(null, undefined, 'Apex')).toBe('Apex');
  });

  it('switches to the owning project when the open project is different', () => {
    expect(documentProjectSwitchTarget('Apex', 'Nurses', ['Apex', 'Nurses'])).toBe('Apex');
    expect(documentProjectSwitchTarget('apex', 'Nurses', ['Apex', 'Nurses'])).toBe('Apex');
    expect(documentProjectSwitchTarget('Nurses', 'Nurses', ['Apex', 'Nurses'])).toBeNull();
    expect(documentProjectSwitchTarget('Unknown', 'Nurses', ['Apex', 'Nurses'])).toBeNull();
  });

  it('does not switch onto a project missing from the accessible list', () => {
    expect(documentProjectSwitchTarget('Nurses', 'Apex', ['Apex'])).toBeNull();
  });

  it('does not switch restricted users onto a foreign document project', () => {
    expect(documentProjectSwitchTarget('Nurses', 'Apex', ['Apex', 'Nurses'], { isRestricted: true })).toBeNull();
  });

  it('holds the route guard while the owning project is still unresolved', () => {
    const link = parseDocumentDeepLink('/adr/adr-1');
    expect(shouldHoldDocumentRoute({
      link,
      lookupPending: true,
      switchTarget: null,
    })).toBe(true);
    expect(shouldHoldDocumentRoute({
      link,
      lookupPending: false,
      switchTarget: 'Apex',
    })).toBe(true);
    expect(shouldHoldDocumentRoute({
      link: null,
      lookupPending: false,
      switchTarget: 'Apex',
    })).toBe(true);
    expect(shouldHoldDocumentRoute({
      link,
      lookupPending: false,
      switchTarget: null,
    })).toBe(false);
  });
});
