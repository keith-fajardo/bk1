import { describe, expect, test } from 'bun:test';
import { diffColumns } from '../src/lineage';

// The tracer's v1 sweet spot: a CTE with a single FROM source and explicitly named columns.
// Keeps these tests about the DIFF logic, not tracer edge cases (covered elsewhere).
const wrap = (selectList: string) => `
  with src as (select * from raw.orders)
  select ${selectList} from src
`;

describe('diffColumns', () => {
  test('detects a removed column', () => {
    const before = wrap('id, amount, status');
    const after = wrap('id, status');
    const d = diffColumns(before, after);
    expect(d.removed).toEqual(['amount']);
    expect(d.added).toEqual([]);
    expect(d.redefined).toEqual([]);
  });

  test('detects an added column', () => {
    const d = diffColumns(wrap('id, amount'), wrap('id, amount, currency'));
    expect(d.added).toEqual(['currency']);
    expect(d.removed).toEqual([]);
  });

  test('a rename surfaces as one removed + one added', () => {
    const d = diffColumns(wrap('id, amount'), wrap('id, amount as total'));
    expect(d.removed).toEqual(['amount']);
    expect(d.added).toEqual(['total']);
  });

  test('detects a redefined column (same name, different source)', () => {
    const before = wrap('id, amount as total');
    const after = wrap('id, gross as total');
    const d = diffColumns(before, after);
    expect(d.redefined).toEqual(['total']);
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual([]);
  });

  test('no change → empty diff', () => {
    const sql = wrap('id, amount, status');
    const d = diffColumns(sql, sql);
    expect(d).toEqual({ added: [], removed: [], redefined: [] });
  });

  test('unparseable SQL yields an empty diff rather than throwing', () => {
    const d = diffColumns('this is not sql', wrap('id'));
    expect(d).toEqual({ added: [], removed: [], redefined: [] });
  });
});
