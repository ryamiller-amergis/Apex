import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeAtomic(directory, filename, body) {
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${filename}.${process.pid}.tmp`);
  try {
    await writeFile(temp, body);
    await rename(temp, path.join(directory, filename));
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
