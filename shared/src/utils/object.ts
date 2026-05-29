/**
 * Object utilities for clean data transformations
 */

/**
 * Pick only defined (not undefined) fields from object
 * Removes undefined values, keeps null
 */
export const pickDefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
};

/**
 * Apply defaults to object (only for undefined fields)
 */
export const withDefaults = <T extends Record<string, unknown>>(
  obj: Partial<T>,
  defaults: T
): T => ({ ...defaults, ...pickDefined(obj) } as T);

/**
 * Pick specific keys from object
 */
export const pick = <T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> => {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
};
