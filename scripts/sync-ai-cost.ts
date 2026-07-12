import 'dotenv/config';
import { runCursorBillingSync } from '../src/server/services/cursorBillingSyncService';
import { runCostAllocation } from '../src/server/services/aiCostAllocationService';

async function main() {
  console.log('[sync] Starting Cursor billing sync...');
  await runCursorBillingSync();
  console.log('[sync] Running cost allocation...');
  await runCostAllocation();
  console.log('[sync] Done.');
}

main().catch(console.error);
