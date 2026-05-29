export type Result<T, E = string> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

export const Result = {
  ok: <T, E = string>(value: T): Result<T, E> => ({ ok: true, value }),
  err: <E = string>(error: E): Result<never, E> => ({ ok: false, error }),
  
  isOk: <T, E>(result: Result<T, E>): result is { ok: true; value: T } => result.ok,
  isErr: <T, E>(result: Result<T, E>): result is { ok: false; error: E } => !result.ok,
  
  map: <T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> => {
    if (result.ok) {
      return Result.ok(fn(result.value));
    }
    return result as Result<U, E>;
  },
  
  mapErr: <T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> => {
    if (!result.ok) {
      return Result.err(fn(result.error));
    }
    return result;
  },
  
  unwrap: <T, E>(result: Result<T, E>): T => {
    if (result.ok) {
      return result.value;
    }
    throw new Error(`Unwrapped error result: ${result.error}`);
  },
  
  unwrapOr: <T, E>(result: Result<T, E>, defaultValue: T): T => {
    if (result.ok) {
      return result.value;
    }
    return defaultValue;
  }
};

export type Maybe<T> = T | null | undefined;

export const Maybe = {
  isNone: <T>(value: Maybe<T>): value is null | undefined => 
    value === null || value === undefined,
  
  isSome: <T>(value: Maybe<T>): value is T => 
    value !== null && value !== undefined,
  
  map: <T, U>(value: Maybe<T>, fn: (value: T) => U): Maybe<U> => {
    if (Maybe.isSome(value)) {
      return fn(value);
    }
    return value as null | undefined;
  },
  
  unwrapOr: <T>(value: Maybe<T>, defaultValue: T): T => {
    if (Maybe.isSome(value)) {
      return value;
    }
    return defaultValue;
  }
};