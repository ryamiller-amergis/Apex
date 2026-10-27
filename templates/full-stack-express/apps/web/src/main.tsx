// Replaced by FEAT-010 Self-Service Profile Screen.
import { CONTRACTS_STUB } from '@project-scope/contracts';
import { UI_STUB } from '@project-scope/ui';

const marker = 'starter';
const root = document.querySelector('#root');

if (!root) {
  throw new Error('Missing #root');
}

root.textContent = `${marker} ${CONTRACTS_STUB} ${UI_STUB}`;
