import { NEW_PRODUCT_PROTOTYPE_MARKER } from '../../shared/types/productBuild';
import {
  isNewProductPrototypePrompt,
  resolveUiLabGrounding,
} from '../services/uiLabBedrockService';

describe('new product prototype grounding', () => {
  it('keeps an ordinary UI Lab request on the existing product design system', () => {
    expect(isNewProductPrototypePrompt('Add a filter to the document table')).toBe(false);
    expect(resolveUiLabGrounding('Add a filter to the document table', 'MaxView')).toEqual({
      grounding: 'existing-app',
      designSystemName: 'MaxView',
    });
  });

  it('treats a product-build prompt as a new application and uses its name', () => {
    const prompt = `${NEW_PRODUCT_PROTOTYPE_MARKER}To-Do-List-p2". Design only this application.`;
    expect(resolveUiLabGrounding(prompt, 'To-Do-List-p2')).toEqual({
      grounding: 'new-product',
      designSystemName: 'To-Do-List-p2',
    });
  });
});
