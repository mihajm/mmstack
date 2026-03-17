import { createNamespace } from './create-namespace';

describe('createNamespace', () => {
  it('should create a namespace with compiled translation', () => {
    const translation = { greeting: 'Hello' };
    const ns = createNamespace('core', translation);
    
    expect(ns.translation.namespace).toBe('core');
    expect(ns.translation.flat).toEqual({ greeting: 'Hello' });
  });

  it('should create translations for other locales', () => {
    const translation = { greeting: 'Hola' };
    const ns = createNamespace('core', { greeting: 'Hello' });
    
    // We mock the shape to match translation input format
    const localeTranslation = ns.createTranslation('es', translation);
    
    expect(localeTranslation.locale).toBe('es');
    expect(localeTranslation.namespace).toBe('core');
    expect(localeTranslation.flat).toEqual({ greeting: 'Hola' });
  });

  it('should merge namespaces correctly', () => {
    const coreNs = createNamespace('core', { greeting: 'Hello' });
    const featureNs = coreNs.createMergedNamespace('feature', { action: 'Go' });
    
    expect(featureNs.translation.namespace).toBe('feature');
    expect(featureNs.translation.flat).toEqual({ action: 'Go' });
    
    // Check if new translations on the merged ns are built properly
    const featureEs = featureNs.createTranslation('es', { action: 'Ir' });
    expect(featureEs.locale).toBe('es');
    expect(featureEs.flat).toEqual({ action: 'Ir' });
  });
});
