import type { ApiKeyCadence, ApiKeyScope } from '../../shared/types/apiKey';
import {
  API_KEY_CADENCES,
  API_KEY_SCOPE_HINTS,
  API_KEY_SCOPE_LABELS,
  API_KEY_SCOPES,
} from '../../shared/types/apiKey';
import { API_KEY_EXPIRY_REMINDER_DAYS } from '../../shared/types/apiKeyExpiryNotifications';

/** Human-readable cadence labels for selects and grid cells. */
export const API_KEY_CADENCE_LABELS: Record<ApiKeyCadence, string> = {
  '30d': '30 days',
  '60d': '60 days',
  '90d': '90 days',
  '180d': '180 days',
  '1y': '1 year',
  none: 'No expiration',
};

export const API_KEY_CADENCE_OPTIONS = API_KEY_CADENCES.map((value) => ({
  value,
  label: API_KEY_CADENCE_LABELS[value],
}));

export const API_KEY_SCOPE_OPTIONS = API_KEY_SCOPES.map((value) => ({
  value,
  label: API_KEY_SCOPE_LABELS[value],
  hint: API_KEY_SCOPE_HINTS[value],
}));

export function formatApiKeyScopes(scopes: ApiKeyScope[]): string {
  if (!scopes.length) return 'None (ping only)';
  return scopes.map((s) => API_KEY_SCOPE_LABELS[s] ?? s).join(', ');
}

/** Shown under the expiration cadence control so admins know when they will be notified. */
export const API_KEY_EXPIRY_NOTIFICATION_HINT = (() => {
  const labels = API_KEY_EXPIRY_REMINDER_DAYS.map((days) =>
    days === 1 ? '1 day' : `${days} days`,
  );
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
  return `Project admins with API key access receive in-app and Teams reminders ${list} before a key expires. Keys with no expiration do not send reminders.`;
})();

export const API_KEY_SCOPES_FIELD_HINT =
  'Choose which public APIs this key may call. View and submit only — manage actions stay in the Admin UI. Connectivity ping works for any valid key.';

export function formatApiKeyDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatApiKeyStatus(status: 'active' | 'expired'): string {
  return status === 'active' ? 'Active' : 'Expired';
}
