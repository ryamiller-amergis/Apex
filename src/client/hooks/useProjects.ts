import { useQuery } from '@tanstack/react-query';

export interface AdoProject {
  id: string;
  name: string;
  description: string;
}

export interface AdoTeam {
  id: string;
  name: string;
}

async function fetchProjects(): Promise<AdoProject[]> {
  const res = await fetch('/api/projects', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch projects');
  return res.json();
}

async function fetchProjectTeams(project: string): Promise<AdoTeam[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/teams`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch teams');
  return res.json();
}

export function useProjects() {
  return useQuery<AdoProject[]>({
    queryKey: ['ado-projects'],
    queryFn: fetchProjects,
    staleTime: 5 * 60 * 1000,
  });
}

export function useProjectTeams(project: string | null) {
  return useQuery<AdoTeam[]>({
    queryKey: ['ado-project-teams', project],
    queryFn: () => fetchProjectTeams(project!),
    enabled: !!project,
    staleTime: 5 * 60 * 1000,
  });
}

async function fetchProjectAreaPaths(project: string): Promise<string[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/area-paths`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch area paths');
  return res.json();
}

export function useProjectAreaPaths(project: string | null) {
  return useQuery<string[]>({
    queryKey: ['ado-project-area-paths', project],
    queryFn: () => fetchProjectAreaPaths(project!),
    enabled: !!project,
    staleTime: 5 * 60 * 1000,
  });
}
