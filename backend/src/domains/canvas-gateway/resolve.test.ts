import { test, expect, describe } from 'bun:test';
import { parseRefs, resolveNode, formatResolved, resolveFromMap } from './resolve';

// These are pure-function unit tests — resolve.ts touches no I/O, so there's
// nothing to mock and nothing to boot. The node "database" is just a Map.

describe('parseRefs', () => {
  test('empty content → no refs', () => {
    expect(parseRefs('')).toEqual([]);
    expect(parseRefs('just some text, no refs')).toEqual([]);
  });

  test('single whitespace-prefixed ref', () => {
    expect(parseRefs('manager +engineering')).toEqual(['engineering']);
  });

  test('multiple refs, first-appearance order', () => {
    expect(parseRefs('+a then +b then +c')).toEqual(['a', 'b', 'c']);
  });

  test('de-duplicates repeated refs', () => {
    expect(parseRefs('+a +b +a')).toEqual(['a', 'b']);
  });

  test('ref at start of string', () => {
    expect(parseRefs('+first rest')).toEqual(['first']);
  });

  test('newline-separated refs', () => {
    expect(parseRefs('inbox\n+chat\n+log')).toEqual(['chat', 'log']);
  });

  test('does NOT match + without a whitespace/start boundary', () => {
    // "C++", "1+2", "a+b" must not be read as references.
    expect(parseRefs('C++ is a language')).toEqual([]);
    expect(parseRefs('1+2=3')).toEqual([]);
    expect(parseRefs('foo+bar')).toEqual([]);
  });

  test('id charset: alnum, underscore, hyphen', () => {
    expect(parseRefs('+m_ab12_cd +node-id-3')).toEqual(['m_ab12_cd', 'node-id-3']);
  });
});

describe('resolveNode', () => {
  const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

  test('node with no refs', () => {
    const tree = resolveNode(map({ a: 'hello' }), 'a', new Set(), 0);
    expect(tree).toEqual({ content: 'hello', refs: new Map() });
  });

  test('missing root → null', () => {
    expect(resolveNode(map({ a: 'x' }), 'nope', new Set(), 0)).toBeNull();
  });

  test('resolves a simple ref', () => {
    const tree = resolveNode(map({ a: 'see +b', b: 'B body' }), 'a', new Set(), 0);
    expect(tree?.refs.has('b')).toBe(true);
    expect(tree?.refs.get('b')?.content).toBe('B body');
  });

  test('resolves nested refs', () => {
    const tree = resolveNode(map({ a: '+b', b: '+c', c: 'leaf' }), 'a', new Set(), 0);
    expect(tree?.refs.get('b')?.refs.get('c')?.content).toBe('leaf');
  });

  test('missing ref is skipped (not in refs map)', () => {
    const tree = resolveNode(map({ a: 'see +ghost' }), 'a', new Set(), 0);
    expect(tree?.refs.has('ghost')).toBe(false);
  });

  test('cycle A→B→A is broken (B does not re-resolve A)', () => {
    const tree = resolveNode(map({ a: '+b', b: '+a' }), 'a', new Set(), 0);
    // a resolves b; b's content references a, but a is on the path → skipped.
    expect(tree?.refs.get('b')?.refs.has('a')).toBe(false);
  });

  test('diamond A→B→D and A→D resolves D in both places (not a cycle)', () => {
    const tree = resolveNode(
      map({ a: '+b +d', b: '+d', d: 'shared' }),
      'a',
      new Set(),
      0,
    );
    expect(tree?.refs.get('d')?.content).toBe('shared'); // direct
    expect(tree?.refs.get('b')?.refs.get('d')?.content).toBe('shared'); // via b
  });

  test('depth cap stops expansion at MAX_DEPTH (8 levels)', () => {
    // Build a chain n0 → n1 → ... → n10. Past depth 8, refs stop expanding.
    const chain: Record<string, string> = {};
    for (let i = 0; i < 11; i++) chain[`n${i}`] = `+n${i + 1}`;
    chain.n11 = 'bottom';
    const tree = resolveNode(new Map(Object.entries(chain)), 'n0', new Set(), 0);
    // Walk down counting how deep refs go.
    let node = tree;
    let depth = 0;
    while (node && node.refs.size > 0) {
      node = [...node.refs.values()][0]!;
      depth++;
    }
    expect(depth).toBe(8); // capped
  });
});

describe('formatResolved', () => {
  const resolve = (entries: Record<string, string>, root: string) =>
    resolveFromMap(new Map(Object.entries(entries)), root);

  test('node with no refs returns its content verbatim', () => {
    expect(resolve({ a: 'plain text' }, 'a')).toBe('plain text');
  });

  test('inlines a resolved ref as a delimited block', () => {
    const out = resolve({ a: 'before +b after', b: 'INNER' }, 'a')!;
    expect(out).toContain('INNER');
    expect(out).toContain('+b');
    expect(out).toContain('before');
    expect(out).toContain('after');
    // "after" must NOT cling to the closing border line.
    expect(out).toMatch(/╰─+\n.*after/s);
  });

  test('unresolved ref is left literal (skip, not a marker)', () => {
    const out = resolve({ a: 'hi +ghost bye' }, 'a')!;
    expect(out).toBe('hi +ghost bye'); // untouched
    expect(out).not.toContain('not found');
    expect(out).not.toContain('[');
  });

  test('cycle ref is left literal, no infinite loop', () => {
    const out = resolve({ a: '+b', b: 'loop +a' }, 'a')!;
    // a's +b expands; inside, b's +a is a cycle → left literal "+a".
    expect(out).toContain('loop +a');
  });

  test('mixed resolved + unresolved in one node', () => {
    const out = resolve({ a: '+real and +fake', real: 'R' }, 'a')!;
    expect(out).toContain('R'); // real inlined
    expect(out).toContain('+fake'); // fake left literal
  });
});
