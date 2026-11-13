import { escapeCsvCell, serializeCsv } from '../utils/csvSerialize';

describe('csvSerialize', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['carriage\rreturn', '"carriage\rreturn"'],
  ])('escapes %j', (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it.each(['=SUM(A1)', '+1', '-1', '@cmd', '\tx'])('neutralizes formula-leading cell %j', (input) => {
    expect(escapeCsvCell(input).replace(/^"/, '').startsWith(`'${input[0]}`)).toBe(true);
  });

  it('leaves numbers, booleans and empty values alone', () => {
    expect(escapeCsvCell(-1)).toBe('-1');
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('writes only the header for an empty list', () => {
    expect(serializeCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });

  it('joins rows with CRLF', () => {
    expect(serializeCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});
