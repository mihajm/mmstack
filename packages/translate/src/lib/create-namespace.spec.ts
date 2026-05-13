import { createNamespace } from './create-namespace';
import { withParams } from './with-params';

describe('withParams', () => {
  it('is an identity cast at runtime', () => {
    const msg = '{count, plural, one {Hi {name}} other {Hi {name}}}';
    expect(withParams<{ name: string }>(msg)).toBe(msg);
  });

  it('integrates with createNamespace and accepts plain strings for non-default locales', () => {
    const ns = createNamespace('quote', {
      simple: 'Hello',
      complex: withParams<{ name: string }>(
        '{count, plural, one {Hi {name}} other {Hi {name}}}',
      ),
    });

    expect(ns.translation.flat).toEqual({
      simple: 'Hello',
      complex: '{count, plural, one {Hi {name}} other {Hi {name}}}',
    });

    // Non-default locale: branded key accepts any string, no withParams needed.
    const es = ns.createTranslation('es-ES', {
      simple: 'Hola',
      complex: 'Hola {name}',
    });

    expect(es.locale).toBe('es-ES');
    expect(es.flat).toEqual({ simple: 'Hola', complex: 'Hola {name}' });
  });
});

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
