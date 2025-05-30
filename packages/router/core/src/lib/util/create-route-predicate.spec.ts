import { createRoutePredicate } from './create-route-predicate';

describe('createRoutePredicate', () => {
  describe('Base Predicate (No Wildcards)', () => {
    it('should match exact static paths', () => {
      const predicate = createRoutePredicate('/a/b/c');
      expect(predicate('/a/b/c')).toBe(true);
    });

    it('should not match different static paths', () => {
      const predicate = createRoutePredicate('/a/b/c');
      expect(predicate('/a/b/d')).toBe(false);
    });

    it('should allow longer link paths (prefix matching)', () => {
      const predicate = createRoutePredicate('/a/b');
      expect(predicate('/a/b/c/d')).toBe(true);
    });

    it('should not match if link path is shorter than config path', () => {
      const predicate = createRoutePredicate('/a/b/c');
      expect(predicate('/a/b')).toBe(false);
    });

    it('should handle empty paths', () => {
      const predicateEmpty = createRoutePredicate('');
      expect(predicateEmpty('')).toBe(true);
      expect(predicateEmpty('/')).toBe(true);
      expect(predicateEmpty('/a')).toBe(true); // Empty config acts as a prefix

      const predicateSlash = createRoutePredicate('/');
      expect(predicateSlash('')).toBe(true);
      expect(predicateSlash('/')).toBe(true);
      expect(predicateSlash('/a')).toBe(true);
    });

    it('should handle root link path with specific config', () => {
      const predicate = createRoutePredicate('/a');
      expect(predicate('/')).toBe(false);
      expect(predicate('')).toBe(false);
    });

    it('should be case-sensitive', () => {
      const predicate = createRoutePredicate('/a/B/c');
      expect(predicate('/a/b/c')).toBe(false);
      expect(predicate('/a/B/c')).toBe(true);
    });

    describe('Route Parameters', () => {
      it('should match paths with route parameters', () => {
        const predicate = createRoutePredicate('/users/:id');
        expect(predicate('/users/123')).toBe(true);
        expect(predicate('/users/abc')).toBe(true);
      });

      it('should match paths with multiple route parameters', () => {
        const predicate = createRoutePredicate(
          '/books/:bookId/authors/:authorId',
        );
        expect(predicate('/books/123/authors/456')).toBe(true);
      });

      it('should allow longer link paths with route parameters', () => {
        const predicate = createRoutePredicate('/users/:id');
        expect(predicate('/users/123/details')).toBe(true);
      });

      it('should not match if static parts around parameters differ', () => {
        const predicate = createRoutePredicate('/users/:id/settings');
        expect(predicate('/users/123/profile')).toBe(false);
      });
    });

    describe('Matrix Parameters', () => {
      it('should match with exact matrix parameters', () => {
        const predicate = createRoutePredicate('/a;p1=v1/b;p2=v2');
        expect(predicate('/a;p1=v1/b;p2=v2')).toBe(true);
      });

      it('should allow extra matrix parameters in link path', () => {
        const predicate = createRoutePredicate('/a;p1=v1');
        expect(predicate('/a;p1=v1;p2=v2')).toBe(true);
      });

      it('should not match if config matrix param is missing in link', () => {
        const predicate = createRoutePredicate('/a;p1=v1;p2=v2');
        expect(predicate('/a;p1=v1')).toBe(false);
      });

      it('should not match if matrix param value differs', () => {
        const predicate = createRoutePredicate('/a;p1=v1');
        expect(predicate('/a;p1=vX')).toBe(false);
      });

      it('should match with matrix parameters on parameterized segments', () => {
        const predicate = createRoutePredicate('/users/:id;type=admin');
        expect(predicate('/users/123;type=admin')).toBe(true);
        expect(predicate('/users/123;type=guest')).toBe(false);
      });

      it('should handle valueless matrix parameters (parsed as true)', () => {
        const predicate = createRoutePredicate('/a;active'); // Config expects 'active=true'
        expect(predicate('/a;active=true')).toBe(true);
        expect(predicate('/a;active')).toBe(true); // Link also parsed as 'active=true'
      });
    });
  });

  describe('Wildcard (**) Predicate', () => {
    it('** should match zero segments in the middle', () => {
      const predicate = createRoutePredicate('/a/**/b');
      expect(predicate('/a/b')).toBe(true);
    });

    it('** should match zero segments at the beginning', () => {
      const predicate = createRoutePredicate('**/b');
      expect(predicate('/b')).toBe(true);
    });

    it('** should match zero segments at the end', () => {
      const predicate = createRoutePredicate('/a/**');
      expect(predicate('/a')).toBe(true);
    });

    it('** should match one segment', () => {
      const predicate = createRoutePredicate('/a/**/b');
      expect(predicate('/a/x/b')).toBe(true);
      const predicateEnd = createRoutePredicate('/a/**');
      expect(predicateEnd('/a/x')).toBe(true);
      const predicateStart = createRoutePredicate('**/b');
      expect(predicateStart('/x/b')).toBe(true);
    });

    it('** should match multiple segments', () => {
      const predicate = createRoutePredicate('/a/**/b');
      expect(predicate('/a/x/y/z/b')).toBe(true);
      const predicateEnd = createRoutePredicate('/a/**');
      expect(predicateEnd('/a/x/y/z')).toBe(true);
      const predicateStart = createRoutePredicate('**/b');
      expect(predicateStart('/x/y/z/b')).toBe(true);
    });

    it('config path consisting only of ** should match anything', () => {
      const predicate = createRoutePredicate('**');
      expect(predicate('/a/b/c')).toBe(true);
      expect(predicate('/a')).toBe(true);
      expect(predicate('')).toBe(true);
      expect(predicate('/')).toBe(true);
    });

    it('** should not match if surrounding static segments do not match', () => {
      const predicate = createRoutePredicate('/a/**/b');
      expect(predicate('/a/x/y/c')).toBe(false); // 'c' instead of 'b'
      expect(predicate('/z/x/y/b')).toBe(false); // 'z' instead of 'a'
    });

    it('multiple ** segments: first ** is greedy', () => {
      // The recursive implementation should make the first encountered '**' try to match greedily.
      const predicate = createRoutePredicate('/a/**/b/**/c');
      expect(predicate('/a/x/y/b/z/w/c')).toBe(true); // First ** matches x/y, second ** matches z/w
      expect(predicate('/a/b/z/w/c')).toBe(true); // First ** matches zero, second ** matches z/w
      expect(predicate('/a/x/y/b/c')).toBe(true); // First ** matches x/y, second ** matches zero
      expect(predicate('/a/b/c')).toBe(true); // Both ** match zero
    });

    describe('Wildcards with Matrix Parameters', () => {
      it('should match with matrix params on segments before/after **', () => {
        const predicate = createRoutePredicate('/a;p1=v1/**/b;p2=v2');
        expect(predicate('/a;p1=v1/x/y/b;p2=v2')).toBe(true);
        expect(predicate('/a;p1=v1/b;p2=v2')).toBe(true); // ** matches zero
      });

      it('should not match if matrix params differ on segments before **', () => {
        const predicate = createRoutePredicate('/a;p1=v1/**/b');
        expect(predicate('/a;p1=vX/x/b')).toBe(false);
      });

      it('should not match if matrix params differ on segments after **', () => {
        const predicate = createRoutePredicate('/a/**/b;p2=v2');
        expect(predicate('/a/x/b;p2=vX')).toBe(false);
      });

      it('should match if link has extra matrix params on segments around **', () => {
        const predicate = createRoutePredicate('/a;p1=v1/**/b');
        expect(predicate('/a;p1=v1;extra=true/x/y/b;another=val')).toBe(true);
      });
    });
  });

  describe('General Negative Cases', () => {
    it('should not match completely different structures', () => {
      const predicate = createRoutePredicate('/products/categories');
      expect(predicate('/users/profiles')).toBe(false);
    });

    it('wildcard should not satisfy impossible static segments', () => {
      const predicate = createRoutePredicate('/a/**/b');
      expect(predicate('/a/c')).toBe(false); // 'c' isn't 'b' and no more segments for '**'
    });
  });
});
