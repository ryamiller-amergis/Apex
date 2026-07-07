/**
 * Per-key async mutex that prevents overlapping git operations on the
 * same working tree (diff-polling, push, sync).
 */
export class AsyncMutex {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquires a lock for the given key. Returns a release function that
   * MUST be called when the critical section is done (use try/finally).
   */
  async acquire(key: string): Promise<() => void> {
    // Wait for the current holder to release
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, gate);

    return () => {
      this.locks.delete(key);
      release();
    };
  }
}

export const workspaceMutex = new AsyncMutex();
