/**
 * A structured-clone-safe rendering of an `Error` for cross-thread propagation. A worker throw
 * can't cross `postMessage` as an `Error` (methods/prototype are lost), so tasks and store writes
 * serialize failures into this shape and the receiving side rebuilds a real `Error`.
 */
export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
};

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Renders any thrown value (Error or otherwise) into a {@link SerializedError}, chaining `cause`. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause !== undefined ? serializeError(err.cause) : undefined,
    };
  }
  return { name: 'Error', message: stringify(err) };
}

/** Rebuilds a real `Error` (name/message/stack/cause chain preserved) from a {@link SerializedError}. */
export function deserializeError(e: SerializedError): Error {
  const err = new Error(e.message);
  err.name = e.name;
  if (e.stack !== undefined) err.stack = e.stack;
  if (e.cause !== undefined) err.cause = deserializeError(e.cause);
  return err;
}
