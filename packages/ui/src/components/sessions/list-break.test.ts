import { expect, it } from 'vitest';
import { listBreak } from './list-break';

it.each([
  ['1. First', '1. First\n2. '],
  ['9) Last', '9) Last\n10) '],
  ['  - Nested', '  - Nested\n  - '],
  ['* First', '* First\n* '],
  ['+ First', '+ First\n+ '],
  ['1. First\n2. ', '1. First\n'],
  ['- ', ''],
  ['  - ', '  '],
])('continues or exits %j', (input, output) => {
  expect(listBreak(input, input.length, input.length)).toEqual({
    text: output,
    caret: output.length,
  });
});

it('replaces only the selected text and leaves following lines alone', () => {
  expect(listBreak('1. First extra\nTail', 8, 14)).toEqual({
    text: '1. First\n2. \nTail',
    caret: 12,
  });
  expect(listBreak('- hello world', 7, 7)).toEqual({ text: '- hello\n-  world', caret: 10 });
});

it('leaves ordinary text and incomplete markers to the browser', () => {
  expect(listBreak('Hello', 5, 5)).toBeNull();
  expect(listBreak('1.', 2, 2)).toBeNull();
});
