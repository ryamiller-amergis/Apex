import React from 'react';
import { BuildsListView } from './BuildsListView';

interface BuildsViewProps {
  project: string;
  isSuperAdmin?: boolean;
}

/** Builds page. The list and New build action live in BuildsListView. */
export const BuildsView: React.FC<BuildsViewProps> = ({ project, isSuperAdmin = false }) => (
  <BuildsListView project={project} isSuperAdmin={isSuperAdmin} />
);

export default BuildsView;
