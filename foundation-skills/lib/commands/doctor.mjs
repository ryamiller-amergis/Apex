/** doctor command — delegates to lib/doctor.mjs */
import { runDoctor, formatDoctor } from '../doctor.mjs';

export async function doctor({ checkFeed = false } = {}) {
  const result = runDoctor({ checkFeed });
  console.log(formatDoctor(result));
  if (!result.ok) process.exit(1);
}
