declare module 'session-file-store' {
  import type session from 'express-session';

  interface FileStoreOptions {
    path: string;
    ttl?: number;
    retries?: number;
  }

  type FileStoreFactory = (session: typeof session) => new (options: FileStoreOptions) => session.Store;

  const createFileStore: FileStoreFactory;
  export default createFileStore;
}
