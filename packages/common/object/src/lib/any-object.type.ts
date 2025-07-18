/**
 * Represents any non-null object.
 * Useful for generic functions or variables that can accept any object structure.
 * Shorthand for `{ [key: string | number | symbol]: any }`.
 *
 * @example
 * const valid: AnyObject = { key: 'value' }; // OK
 * const alsoValid: AnyObject = {};           // OK
 * const invalid: AnyObject = 123;            // TypeScript Error
 * const alsoInvalid: AnyObject = null;         // TypeScript Error
 */
export type AnyObject = Record<PropertyKey, any>;
