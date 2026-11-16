jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  formatWorkItemPromptSection,
  htmlToText,
} from '../services/playbookSteps/workItemContext';

describe('htmlToText', () => {
  it('keeps line breaks and list items, and decodes entities', () => {
    expect(htmlToText('<div>Open <b>Clock</b>&nbsp;page</div><ol><li>Tap &quot;In&quot;</li><li>See 500</li></ol>'))
      .toBe('Open Clock page\n- Tap "In"\n- See 500');
  });

  it('keeps an inline image as its link', () => {
    expect(htmlToText('<p>Screenshot <img src="https://dev.azure.com/a.png" alt="x"></p>'))
      .toBe('Screenshot [image: https://dev.azure.com/a.png]');
  });
});

describe('formatWorkItemPromptSection', () => {
  it('lists fields, attachment names, links and comments for the agent', () => {
    const section = formatWorkItemPromptSection({
      id: 60597,
      url: 'https://dev.azure.com/amergis/MaxView/_workitems/edit/60597',
      fields: {
        Title: 'Clock-in fails',
        'Repro steps': '<div>Open clock</div><div>Tap In</div>',
      },
      attachments: [{ name: 'har.json', url: 'https://dev.azure.com/attachments/1' }],
      hyperlinks: ['https://portal.azure.com/op/abc'],
      comments: [{ createdBy: 'Pat', createdDate: '2026-11-15T10:00:00.000Z', text: '<p>Still failing</p>' }],
    });

    expect(section).toContain('## Azure DevOps work item 60597');
    expect(section).toContain('Link: https://dev.azure.com/amergis/MaxView/_workitems/edit/60597');
    expect(section).toContain('**Title:** Clock-in fails');
    expect(section).toContain('**Repro steps:**\nOpen clock\nTap In');
    expect(section).toContain('- har.json');
    expect(section).not.toContain('https://dev.azure.com/attachments/1');
    expect(section).toContain('- https://portal.azure.com/op/abc');
    expect(section).toContain('- Pat, 2026-11-15T10:00:00.000Z: Still failing');
  });
});
