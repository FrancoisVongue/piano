// Backend ESLint config — flat config (ESLint 9+).
// Narrow scope: catches the foot-guns that bit us in the observability merge.
// Not a style police — only rules that prevent silent bugs.

import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'prisma/migrations/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      // 1. No `console.*`. We have pino — use it. The one historical exception
      //    was config validation before logger init, but `obs.logger` is eager
      //    so even that path goes through pino now.
      'no-console': 'error',

      // 2. Pino + the Temporal-log wrapper share the SAME shape: `log.X(obj, msg)`.
      //    `log.info('msg', { fields })` with the string FIRST silently
      //    demotes the fields to interpolation values — they vanish from
      //    structured queries. This selector catches that exact mistake.
      //
      //    Allowed:    log.info('NATS connected')
      //                log.info({ port: 3031 }, 'Backend running')
      //    Blocked:    log.info('Backend running', { port: 3031 })
      //
      //    Note: this is intentionally narrow — only triggers when the first
      //    arg is a string literal AND there's a 2nd arg. Variable-message
      //    cases like `log.info(somePrefixVar, ctx)` slip through, but those
      //    are rare and usually intentional.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='log'][callee.property.name=/^(info|warn|error|debug|trace|fatal)$/][arguments.length>=2][arguments.0.type='Literal']",
          message:
            'log.X(obj, msg) — fields object FIRST, message SECOND. Putting the string first turns fields into interpolation values and breaks structured queries.',
        },
        {
          selector:
            "CallExpression[callee.object.name='log'][callee.property.name=/^(info|warn|error|debug|trace|fatal)$/][arguments.length>=2][arguments.0.type='TemplateLiteral']",
          message:
            "Template literals in log messages defeat structured logging. Move dynamic parts into the fields object: log.info({ userId }, 'user signed in') — never log.info(`user ${id} signed in`).",
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='BlockStatement'][body.body.length=0]",
          message:
            'Empty .catch(() => {}) silently swallows promise rejections. Either log + continue (best-effort) or let it propagate.',
        },
      ],

      // 3. Empty catch blocks. `try { ... } catch {}` is the same anti-pattern
      //    in synchronous form.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
];
