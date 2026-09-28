import type { ExcalidrawScene } from '../../shared/types/diagram';
import { APEX_AI_MERMAID_APP_STATE_KEY } from '../../shared/utils/graphToMermaid';
import { convertDiagramElements } from './diagramConvert';
import { fromDiagramScene } from './diagramScene';

type ConvertFn = (
  skeleton: unknown[] | null,
  opts?: { regenerateIds: boolean },
) => unknown[];

export function sceneHasAiMermaid(scene: ExcalidrawScene): boolean {
  const mermaid = scene.appState?.[APEX_AI_MERMAID_APP_STATE_KEY];
  return typeof mermaid === 'string' && mermaid.trim().length > 0;
}

export async function materializeDiagramScene(
  convertToExcalidrawElements: ConvertFn,
  scene: ExcalidrawScene,
): Promise<ExcalidrawScene> {
  const { elements, appState, files } = fromDiagramScene(scene);
  const mermaid = appState[APEX_AI_MERMAID_APP_STATE_KEY];
  if (typeof mermaid === 'string' && mermaid.trim()) {
    const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
    const parsed = await parseMermaidToExcalidraw(mermaid.trim());
    const converted = convertToExcalidrawElements(parsed.elements, { regenerateIds: false });
    const { [APEX_AI_MERMAID_APP_STATE_KEY]: _removed, ...persistableAppState } = appState;
    return {
      elements: converted,
      appState: persistableAppState,
      files: {
        ...files,
        ...(parsed.files ?? {}),
      },
    };
  }

  return {
    elements: convertDiagramElements(convertToExcalidrawElements, elements),
    appState,
    files,
  };
}
