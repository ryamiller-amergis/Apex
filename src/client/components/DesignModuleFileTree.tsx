import React from 'react';
import styles from './DesignModuleFileTree.module.css';

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  fileCount: number;
  children: TreeNode[];
}

function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode = {
    name: '',
    path: '',
    isFile: false,
    fileCount: 0,
    children: [],
  };
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    let acc = '';
    parts.forEach((part, idx) => {
      acc = acc ? `${acc}/${part}` : part;
      const isFile = idx === parts.length - 1;
      let child = node.children.find(
        (c) => c.name === part && c.isFile === isFile
      );
      if (!child) {
        child = {
          name: part,
          path: acc,
          isFile,
          fileCount: 0,
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    });
  }

  const countFiles = (n: TreeNode): number => {
    if (n.isFile) return 1;
    n.fileCount = n.children.reduce((sum, c) => sum + countFiles(c), 0);
    return n.fileCount;
  };
  root.children.forEach(countFiles);

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(root.children);
  return root.children;
}

const FolderGlyph: React.FC = () => (
  <svg
    className={styles.glyph}
    width={13}
    height={13}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
  >
    <path
      d="M1.5 4.5c0-.6.4-1 1-1H6l1.5 1.5h6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1v-7.5z"
      stroke="currentColor"
      strokeWidth={1.2}
    />
  </svg>
);

const FileGlyph: React.FC = () => (
  <svg
    className={styles.glyph}
    width={13}
    height={13}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
  >
    <path
      d="M4 2.5h5L12 5.5V13a.5.5 0 01-.5.5h-7A.5.5 0 014 13V3a.5.5 0 01.5-.5z"
      stroke="currentColor"
      strokeWidth={1.2}
    />
  </svg>
);

const TreeRows: React.FC<{ nodes: TreeNode[]; depth: number }> = ({
  nodes,
  depth,
}) => (
  <>
    {nodes.map((n) => (
      <div key={n.path}>
        <div
          className={`${styles.row} ${n.isFile && /\.test\.|__tests__/.test(n.path) ? styles.testFile : ''}`}
          style={{ paddingLeft: depth * 14 }}
        >
          {n.isFile ? <FileGlyph /> : <FolderGlyph />}
          <span className={n.isFile ? styles.fileName : styles.folderName}>
            {n.name}
          </span>
          {!n.isFile && <span className={styles.count}>{n.fileCount}</span>}
        </div>
        {n.children.length > 0 && (
          <TreeRows nodes={n.children} depth={depth + 1} />
        )}
      </div>
    ))}
  </>
);

interface DesignModuleFileTreeProps {
  files: string[];
  emptyLabel?: string;
}

export const DesignModuleFileTree: React.FC<DesignModuleFileTreeProps> = ({
  files,
  emptyLabel = 'No matched files yet.',
}) => {
  if (files.length === 0) {
    // Keep the anchor target mounted in the empty state so walkthrough coachmarks
    // (and any test id consumers) can resolve the "Matched files" tree before a
    // glob/data-dependent preview has produced results.
    return (
      <div
        className={styles.empty}
        {...{ 'data-testid': 'design-module-file-tree' }}
      >
        {emptyLabel}
      </div>
    );
  }
  const tree = buildTree(files);
  return (
    <div className={styles.tree} {...{ 'data-testid': 'design-module-file-tree' }}>
      <TreeRows nodes={tree} depth={0} />
    </div>
  );
};

export default DesignModuleFileTree;
