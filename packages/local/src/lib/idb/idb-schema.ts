type IndexSchema = {
  // The property on your object to index.
  keyPath: string | string[];
  // Standard options like { unique: true, multiEntry: false }.
  options?: IDBIndexParameters;
};

/** The schema definition for a single object store (table). */
export type IDBTableSchema<
  T extends Record<PropertyKey, any> = Record<PropertyKey, any>,
  TKey extends keyof T & string = keyof T & string,
> = T[TKey] extends IDBValidKey
  ? {
      /** The property name to use as the primary key. */
      primaryKey: TKey;
      /**
       * If true, the primary key will be auto-incrementing.
       * @default false
       */
      autoIncrement?: boolean;
      /** A map of index names to their definitions. */
      indexes?: Record<string, IndexSchema>;
    }
  : never;

/** The complete schema for the database, mapping table names to their schemas. */
export type IDBSchema = Record<string, IDBTableSchema>;
