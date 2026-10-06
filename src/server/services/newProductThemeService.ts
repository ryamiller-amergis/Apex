export interface NewProductTheme {
  id: 'focus' | 'operations' | 'insight' | 'community' | 'commerce' | 'calm';
  name: string;
  rationale: string;
  colors: {
    primary: string;
    primaryHover: string;
    accent: string;
    page: string;
    surface: string;
    text: string;
    muted: string;
    border: string;
    success: string;
    danger: string;
  };
  layout: string;
  components: string;
}

interface ThemeCandidate extends NewProductTheme {
  keywords: string[];
}

const THEMES: ThemeCandidate[] = [
  {
    id: 'focus',
    name: 'Focus',
    rationale: 'A quiet, task-first workspace for productivity and personal organization.',
    keywords: [
      'task', 'todo', 'to-do', 'checklist', 'work item', 'productivity',
      'note', 'plan', 'organize', 'complete', 'assignment',
    ],
    colors: {
      primary: '#4F46E5',
      primaryHover: '#4338CA',
      accent: '#EEF2FF',
      page: '#F8FAFC',
      surface: '#FFFFFF',
      text: '#172033',
      muted: '#64748B',
      border: '#E2E8F0',
      success: '#15803D',
      danger: '#B91C1C',
    },
    layout: 'Use one centered workspace with generous margins and a narrow reading width. Keep navigation minimal.',
    components: 'Use crisp cards, compact inputs, clear checkboxes, subtle dividers, and restrained shadows.',
  },
  {
    id: 'operations',
    name: 'Command',
    rationale: 'A dense, dependable workspace for schedules, cases, inventory, and operational work.',
    keywords: [
      'operation', 'schedule', 'case', 'inventory', 'dispatch', 'staff',
      'workflow', 'queue', 'ticket', 'admin', 'status', 'tracking',
    ],
    colors: {
      primary: '#075985',
      primaryHover: '#0C4A6E',
      accent: '#E0F2FE',
      page: '#F1F5F9',
      surface: '#FFFFFF',
      text: '#0F172A',
      muted: '#64748B',
      border: '#CBD5E1',
      success: '#047857',
      danger: '#B91C1C',
    },
    layout: 'Use a structured application shell with clear hierarchy and efficient use of horizontal space.',
    components: 'Use compact toolbars, status chips, tables or lists where useful, and prominent primary actions.',
  },
  {
    id: 'insight',
    name: 'Insight',
    rationale: 'A data-led theme for analytics, reporting, finance, and measured outcomes.',
    keywords: [
      'analytics', 'report', 'dashboard', 'metric', 'finance', 'cost',
      'trend', 'insight', 'performance', 'chart', 'forecast',
    ],
    colors: {
      primary: '#0369A1',
      primaryHover: '#075985',
      accent: '#ECFEFF',
      page: '#F8FAFC',
      surface: '#FFFFFF',
      text: '#0F172A',
      muted: '#64748B',
      border: '#E2E8F0',
      success: '#059669',
      danger: '#DC2626',
    },
    layout: 'Use a clear dashboard grid with strong number hierarchy and enough whitespace to compare information.',
    components: 'Use metric cards, simple charts, filters, concise labels, and accessible data summaries.',
  },
  {
    id: 'community',
    name: 'Gather',
    rationale: 'A warm, people-centered theme for collaboration, learning, communication, and services.',
    keywords: [
      'community', 'team', 'message', 'learn', 'student', 'teacher',
      'employee', 'member', 'collaborate', 'profile', 'social',
    ],
    colors: {
      primary: '#7C3AED',
      primaryHover: '#6D28D9',
      accent: '#F3E8FF',
      page: '#FAF7FF',
      surface: '#FFFFFF',
      text: '#241B35',
      muted: '#6B6475',
      border: '#E9DDF5',
      success: '#15803D',
      danger: '#C2410C',
    },
    layout: 'Use friendly spacing, readable content widths, and clear grouping around people and shared activity.',
    components: 'Use rounded cards, avatars when relevant, approachable empty states, and conversational labels.',
  },
  {
    id: 'commerce',
    name: 'Market',
    rationale: 'A confident visual theme for catalogs, bookings, subscriptions, and transactions.',
    keywords: [
      'shop', 'commerce', 'product', 'catalog', 'order', 'booking',
      'reservation', 'payment', 'price', 'subscription', 'customer',
    ],
    colors: {
      primary: '#B45309',
      primaryHover: '#92400E',
      accent: '#FEF3C7',
      page: '#FFFBEB',
      surface: '#FFFFFF',
      text: '#292524',
      muted: '#78716C',
      border: '#E7E5E4',
      success: '#15803D',
      danger: '#BE123C',
    },
    layout: 'Use a polished content grid with prominent actions and an easy path from discovery to completion.',
    components: 'Use image-ready cards, strong calls to action, clear prices or availability, and reassuring summaries.',
  },
  {
    id: 'calm',
    name: 'Calm',
    rationale: 'A neutral, accessible default when the product does not strongly match another theme.',
    keywords: [],
    colors: {
      primary: '#0F766E',
      primaryHover: '#115E59',
      accent: '#CCFBF1',
      page: '#F8FAFC',
      surface: '#FFFFFF',
      text: '#1F2937',
      muted: '#64748B',
      border: '#E2E8F0',
      success: '#15803D',
      danger: '#B91C1C',
    },
    layout: 'Use a simple responsive shell, clear page title, and content grouped by the user’s main task.',
    components: 'Use familiar controls, medium-radius cards, direct labels, and visible focus and error states.',
  },
];

function countKeywordHits(text: string, keywords: string[]): number {
  return keywords.reduce((score, keyword) => (
    text.includes(keyword) ? score + (keyword.includes(' ') ? 3 : 2) : score
  ), 0);
}

export function selectNewProductTheme(scope: string): NewProductTheme {
  const text = scope.toLowerCase();
  let selected = THEMES[THEMES.length - 1];
  let bestScore = 0;

  for (const theme of THEMES.slice(0, -1)) {
    const score = countKeywordHits(text, theme.keywords);
    if (score > bestScore) {
      selected = theme;
      bestScore = score;
    }
  }

  const { keywords: _keywords, ...result } = selected;
  return result;
}

export function renderNewProductTheme(theme: NewProductTheme): string {
  const colors = Object.entries(theme.colors)
    .map(([token, value]) => `- ${token}: ${value}`)
    .join('\n');
  return [
    `## Suggested starting theme — ${theme.name}`,
    '',
    theme.rationale,
    '',
    'Treat this as a starting point. Tailor the hierarchy and components to the product brief, while keeping the palette consistent.',
    '',
    '### Color tokens',
    colors,
    '',
    `### Layout direction\n${theme.layout}`,
    '',
    `### Component direction\n${theme.components}`,
  ].join('\n');
}
