import type React from 'react';
import { ApexLoader } from './ApexLoader';

interface ViewSkeletonProps {
  rows?: number;
}

export const ViewSkeleton: React.FC<ViewSkeletonProps> = () => (
  <ApexLoader fullscreen />
);
