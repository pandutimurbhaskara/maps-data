import { describe, expect, it } from 'vitest';
import type { SqlParameter } from './mapDoc';
import { CompileError, compileQuery, placeholders } from './sqlParams';

const params: SqlParameter[] = [
  { id: '1', type: 'Category', name: 'Kinds', item: { sqlName: 'kinds', value: ['cafe', 'park'] }, values: ['cafe', 'park', 'shop'], selectionMode: 'multi' },
  { id: '2', type: 'Numeric', name: 'Min', item: { sqlName: 'min_value', value: 10 }, min: 0, max: 100, step: 1 },
  { id: '3', type: 'NumericRange', name: 'Range', start: { sqlName: 'lo', value: 1 }, end: { sqlName: 'hi', value: 9 }, min: 0, max: 10, step: 1 },
  { id: '4', type: 'DateRange', name: 'When', start: { sqlName: 'from_d', value: '2026-01-01' }, end: { sqlName: 'to_d', value: '2026-01-31' } },
];

describe('compileQuery', () => {
  it('compiles each parameter type to DuckDB and binds only what is used', () => {
    const { source, queryParameters } = compileQuery(
      'SELECT * FROM t WHERE kind IN {{kinds}} AND v >= {{ min_value }} AND d BETWEEN {{from_d}} AND {{to_d}}',
      params,
    );
    expect(source).toBe(
      'SELECT * FROM t WHERE kind IN (SELECT unnest(CAST(CAST($kinds AS JSON) AS VARCHAR[]))) AND v >= $min_value AND d BETWEEN CAST($from_d AS DATE) AND CAST($to_d AS DATE)',
    );
    expect(queryParameters).toEqual({ kinds: ['cafe', 'park'], min_value: 10, from_d: '2026-01-01', to_d: '2026-01-31' });
  });

  it('returns null parameters for a template without placeholders', () => {
    expect(compileQuery('SELECT 1', params)).toEqual({ source: 'SELECT 1', queryParameters: null });
  });

  it('rejects unknown placeholders and invalid sqlNames', () => {
    expect(() => compileQuery('SELECT {{nope}}', params)).toThrow(CompileError);
    const bad: SqlParameter = { ...(params[1] as Extract<SqlParameter, { type: 'Numeric' }>), item: { sqlName: 'p__x', value: 1 } };
    expect(() => compileQuery('SELECT {{p__x}}', [bad])).toThrow(/invalid parameter name/);
  });

  it('lists placeholders once each', () => {
    expect(placeholders('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });
});
