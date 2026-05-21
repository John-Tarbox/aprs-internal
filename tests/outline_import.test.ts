/**
 * Parser tests for outline_import.service. Runs via Node's built-in
 * test runner with tsx:
 *
 *   npx tsx --test tests/outline_import.test.ts
 *
 * (Or: `npm test` — the package.json script wires that up.) These
 * tests cover the cases that bit us during the real-outline shakedown:
 * Word-style 1/a/i/1 marker rotation, alpha-vs-roman disambiguation,
 * dotted-numeric prefixes, indentation-only outlines, and notes
 * accumulation between headings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutline } from '../src/services/outline_import.service.ts';

describe('parseOutline', () => {
  it('produces 0 cards on empty input', () => {
    const r = parseOutline('');
    assert.equal(r.totalCards, 0);
    assert.equal(r.tree.length, 0);
    assert.ok(r.warnings.length > 0, 'should warn about empty');
  });

  it('parses a simple tab-indented outline', () => {
    const r = parseOutline('Root\n\tChild A\n\tChild B\n\t\tGrandchild');
    assert.equal(r.totalCards, 4);
    assert.equal(r.maxDepth, 3);
    assert.equal(r.tree[0].title, 'Root');
    assert.equal(r.tree[0].children.length, 2);
    assert.equal(r.tree[0].children[0].title, 'Child A');
    assert.equal(r.tree[0].children[1].title, 'Child B');
    assert.equal(r.tree[0].children[1].children[0].title, 'Grandchild');
  });

  it('parses 1./a./i. Word-style markers without indentation', () => {
    const input = [
      '1. Foo',
      'a. Foo-a',
      'b. Foo-b',
      'i. Foo-b-i',
      'ii. Foo-b-ii',
      '2. Bar',
    ].join('\n');
    const r = parseOutline(input);
    assert.equal(r.totalCards, 6);
    assert.equal(r.tree.length, 2);
    assert.equal(r.tree[0].title, 'Foo');
    assert.equal(r.tree[1].title, 'Bar');
    assert.equal(r.tree[0].children.length, 2);
    assert.equal(r.tree[0].children[0].title, 'Foo-a');
    assert.equal(r.tree[0].children[1].title, 'Foo-b');
    assert.equal(r.tree[0].children[1].children.length, 2);
    assert.equal(r.tree[0].children[1].children[0].title, 'Foo-b-i');
    assert.equal(r.tree[0].children[1].children[1].title, 'Foo-b-ii');
  });

  it('handles 1/a/i/1 four-level nesting (inner numeric is its own series)', () => {
    const input = [
      '1. Root',
      'a. Mid',
      'i. Deep',
      '1. Leaf one',
      '2. Leaf two',
      'ii. Deep2',
      '1. Leaf three',
    ].join('\n');
    const r = parseOutline(input);
    assert.equal(r.totalCards, 7);
    assert.equal(r.maxDepth, 4);
    // Inner "1." / "2." must be CHILDREN of "Deep" / "Deep2", not
    // siblings of "Root" at depth 0.
    assert.equal(r.tree.length, 1);
    const root = r.tree[0];
    const mid = root.children[0];
    const deep = mid.children[0];
    const deep2 = mid.children[1];
    assert.equal(deep.children.length, 2);
    assert.equal(deep.children[0].title, 'Leaf one');
    assert.equal(deep.children[1].title, 'Leaf two');
    assert.equal(deep2.children.length, 1);
    assert.equal(deep2.children[0].title, 'Leaf three');
  });

  it('disambiguates single "i" as roman when alpha series is open', () => {
    // After "a. X" the next "i." is a roman start, not the 9th letter
    // alpha continuation (alpha would expect "b").
    const r = parseOutline('1. Top\na. Sub\ni. Deep');
    assert.equal(r.totalCards, 3);
    assert.equal(r.maxDepth, 3);
    assert.equal(r.tree[0].children[0].children[0].title, 'Deep');
  });

  it('handles "v" after "iv" as roman continuation', () => {
    // Multi-char "iv" establishes the roman series; single-char "v"
    // that follows must be roman(5), not alpha(22).
    const r = parseOutline('1. Top\na. Sub\ni. r1\nii. r2\niii. r3\niv. r4\nv. r5');
    assert.equal(r.tree[0].children[0].children.length, 5);
    assert.equal(r.tree[0].children[0].children[4].title, 'r5');
  });

  it('does NOT mis-promote "c" or "d" or "l" to roman', () => {
    // The bug we hit: 'c' getting treated as roman(100). Sanity check
    // that an alpha series goes a→b→c→d→e correctly.
    const r = parseOutline('1. Top\na. A\nb. B\nc. C\nd. D\ne. E');
    assert.equal(r.tree[0].children.length, 5);
    assert.equal(r.tree[0].children[4].title, 'E');
  });

  it('parses dotted-numeric prefixes (1.2.3) as explicit depth', () => {
    const r = parseOutline('1. Top\n1.1 Mid\n1.1.1 Deep\n1.1.2 Deep2');
    assert.equal(r.totalCards, 4);
    assert.equal(r.maxDepth, 3);
    assert.equal(r.tree[0].children[0].children[1].title, 'Deep2');
  });

  it('accumulates body text as notes on the preceding heading', () => {
    const r = parseOutline(
      '1. Foo\nsome body paragraph\ncontinuing on next line\n2. Bar'
    );
    assert.equal(r.totalCards, 2);
    assert.ok(r.tree[0].notes && r.tree[0].notes.includes('some body paragraph'));
    assert.ok(r.tree[0].notes && r.tree[0].notes.includes('continuing on next line'));
    assert.equal(r.tree[1].notes, null);
  });

  it('warns and truncates when the outline exceeds MAX_OUTLINE_CARDS', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 600; i++) lines.push(`${i}. Item ${i}`);
    const r = parseOutline(lines.join('\n'));
    assert.equal(r.totalCards, 500);
    assert.ok(r.warnings.some((w) => w.includes('exceeds')));
  });

  it('treats a heading after long sibling chain as continuing the right series', () => {
    // Regression: deep-to-shallow scan should let "6. Foo" match the
    // outer numeric series (lastValue=5) rather than an inner one.
    const input = [
      '1. A',
      '2. B',
      '3. C',
      '4. D',
      '5. E',
      'a. inner-a',
      'b. inner-b',
      '6. F',
    ].join('\n');
    const r = parseOutline(input);
    // "6. F" must be a depth-0 sibling of A-E, not nested.
    assert.equal(r.tree.length, 6);
    assert.equal(r.tree[5].title, 'F');
  });
});
