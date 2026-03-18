import { createNoopDB } from './persistence';

describe('persistence', () => {
  describe('createNoopDB', () => {
    it('should return empty array on getAll', async () => {
      const db = createNoopDB<string>();
      const result = await db.getAll();
      expect(result).toEqual([]);
    });

    it('should not throw on store', async () => {
      const db = createNoopDB<string>();
      await expect(
        db.store({
          key: 'test',
          value: 'value',
          created: Date.now(),
          updated: Date.now(),
          stale: Date.now() + 1000,
          expiresAt: Date.now() + 5000,
          useCount: 0,
        }),
      ).resolves.toBeUndefined();
    });

    it('should not throw on remove', async () => {
      const db = createNoopDB<string>();
      await expect(db.remove('key')).resolves.toBeUndefined();
    });
  });
});
