import { defaultAcceptsMessage, createAcceptsValidator } from './accepts';
import { defaultMaxSizeMessageFactory, createMaxSizeValidator } from './max-size';
import { defaultRejectsMessage, createRejectsValidator } from './rejects';

describe('File Validators', () => {
  // Helper to create a File-like object
  const createFile = (name: string, size: number, type: string): File => {
    return { name, size, type } as any;
  };

  describe('accepts', () => {
    const validatorFactory = createAcceptsValidator(defaultAcceptsMessage);

    it('should return error if mime type does not match', () => {
      const validate = validatorFactory(['image/png', 'image/jpeg']);
      const file = createFile('test.txt', 100, 'text/plain');
      expect(validate(file)).toBe('Must be: image/png, image/jpeg');
    });

    it('should return empty string if mime type matches', () => {
      const validate = validatorFactory(['image/png', 'image/jpeg']);
      const file = createFile('test.png', 100, 'image/png');
      expect(validate(file)).toBe('');
    });

    it('should support wildcards', () => {
      const validate = validatorFactory(['image/*']);
      const pngFile = createFile('test.png', 100, 'image/png');
      const jpgFile = createFile('test.jpg', 100, 'image/jpeg');
      const txtFile = createFile('test.txt', 100, 'text/plain');

      expect(validate(pngFile)).toBe('');
      expect(validate(jpgFile)).toBe('');
      expect(validate(txtFile)).toBe('Must be: image/*');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory(['image/png']);
      expect(validate(null)).toBe('');
    });
  });

  describe('maxSize', () => {
    const validatorFactory = createMaxSizeValidator(defaultMaxSizeMessageFactory);

    it('should return error if file is too large (bytes)', () => {
      const validate = validatorFactory(100, 'b');
      const file = createFile('test.png', 101, 'image/png');
      expect(validate(file)).toBe('Max size 100 b');
    });

    it('should return empty string if file size is within limit', () => {
      const validate = validatorFactory(100, 'b');
      const file = createFile('test.png', 100, 'image/png');
      expect(validate(file)).toBe('');
    });

    it('should support KB multipliers', () => {
      const validate = validatorFactory(1, 'kb');
      const smallFile = createFile('small.png', 1024, 'image/png');
      const largeFile = createFile('large.png', 1025, 'image/png');
      
      expect(validate(smallFile)).toBe('');
      expect(validate(largeFile)).toBe('Max size 1 kb');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory(100);
      expect(validate(null)).toBe('');
    });
  });

  describe('rejects', () => {
    const validatorFactory = createRejectsValidator(defaultRejectsMessage);

    it('should return error if mime type matches a rejected type', () => {
      const validate = validatorFactory(['application/exe', 'application/bat']);
      const file = createFile('danger.exe', 100, 'application/exe');
      expect(validate(file)).toBe('Must not be: application/exe, application/bat');
    });

    it('should return empty string if mime type is not rejected', () => {
      const validate = validatorFactory(['application/exe']);
      const file = createFile('safe.png', 100, 'image/png');
      expect(validate(file)).toBe('');
    });

    it('should support wildcards in rejects', () => {
      const validate = validatorFactory(['video/*']);
      const videoFile = createFile('test.mp4', 100, 'video/mp4');
      const imageFile = createFile('test.png', 100, 'image/png');

      expect(validate(videoFile)).toBe('Must not be: video/*');
      expect(validate(imageFile)).toBe('');
    });

    it('should return empty string for null', () => {
      const validate = validatorFactory(['application/exe']);
      expect(validate(null)).toBe('');
    });
  });
});
