import { buildInterviewBaBrief, cachedInterviewBaBrief } from '../services/interviewBaBrief';

describe('interview application brief', () => {
  it('keeps product sections and drops architecture', () => {
    const brief = buildInterviewBaBrief(`
# Product

## What is Apex?

Apex is the product.

## Key Terminology

- **Interview** — a guided requirements conversation.

## Architecture Overview

- **React** renders the client.
- **Express** serves the API.

## User Workflows

Start an interview from the nav bar.
`);

    expect(brief).toContain('## What is Apex?');
    expect(brief).toContain('## Key Terminology');
    expect(brief).toContain('## User Workflows');
    expect(brief).not.toContain('Architecture Overview');
    expect(brief).not.toContain('Express');
  });

  it('returns the same brief for the same source', () => {
    const source = '## What is Apex?\n\nApex is the product.\n';
    expect(cachedInterviewBaBrief(source)).toBe(cachedInterviewBaBrief(source));
  });
});
