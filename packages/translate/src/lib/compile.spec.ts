import { compileTranslation } from './compile';
import { prependDelim } from './delim';

describe('compile', () => {
  it('should compile a flat translation object', () => {
    const translation = {
      hello: 'world',
      test: 'value',
    };
    
    const compiled = compileTranslation(translation, 'myNs', 'en');
    
    expect(compiled.namespace).toBe('myNs');
    expect(compiled.locale).toBe('en');
    expect(compiled.flat).toEqual({
      hello: 'world',
      test: 'value',
    });
  });

  it('should flatten nested translation objects using prependDelim', () => {
    const translation = {
      common: {
        save: 'Save',
        cancel: 'Cancel',
      },
      errors: {
        invalid: 'Invalid value',
        network: {
          timeout: 'Network timeout',
        }
      }
    };
    
    const compiled = compileTranslation(translation, 'app');
    
    expect(compiled.flat).toEqual({
      [prependDelim('common', 'save')]: 'Save',
      [prependDelim('common', 'cancel')]: 'Cancel',
      [prependDelim('errors', 'invalid')]: 'Invalid value',
      [prependDelim('errors', prependDelim('network', 'timeout'))]: 'Network timeout',
    });
  });
});
