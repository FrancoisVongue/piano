import { log as temporalLog } from '@temporalio/workflow';

// pino-shaped wrapper around Temporal's workflow log. Temporal's native API
// is `(message, attrs)`; pino is `(mergingObject, message)`. Having two
// shapes for `log` in one codebase is a foot-gun — devs paste workflow code
// into a controller and silently lose structured fields. So we converge on
// pino's shape here and route through Temporal's logger underneath.
//
// Only used by code inside the workflow sandbox. Activities and the rest of
// the backend get the same shape from `obs.child(...)` directly.

type Bindings = Record<string, unknown>;

const wrap = (level: 'info' | 'warn' | 'error' | 'debug') =>
  (objOrMsg: Bindings | string, msg?: string): void => {
    if (typeof objOrMsg === 'string') {
      temporalLog[level](objOrMsg);
    } else {
      temporalLog[level](msg ?? '', objOrMsg);
    }
  };

export const log = {
  info: wrap('info'),
  warn: wrap('warn'),
  error: wrap('error'),
  debug: wrap('debug'),
};
