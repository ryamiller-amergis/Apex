import { useMutation } from '@tanstack/react-query';
import type {
  GenerateDiagramInput,
  GenerateDiagramResponse,
} from '../../shared/types/diagram';
import { generateDiagram } from '../services/diagramApi';

export function useGenerateDiagram(projectId: string) {
  return useMutation<GenerateDiagramResponse, Error, GenerateDiagramInput>({
    mutationFn: (input) => generateDiagram(projectId, input),
  });
}
