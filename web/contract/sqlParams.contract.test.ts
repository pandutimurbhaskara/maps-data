import { type QueryParameters, vectorQuerySource } from '@carto/api-client';
import { describe, expect, inject, it } from 'vitest';
import type { SqlParameter } from '../src/lib/mapDoc';
import { compileQuery } from '../src/lib/sqlParams';

const common = { apiBaseUrl: inject('apiBaseUrl'), connectionName: 'osm', accessToken: 'dev' };
const kinds = (value: string[]): SqlParameter[] => [
  { id: 'k', type: 'Category', name: 'Kinds', item: { sqlName: 'kinds', value }, values: ['cafe', 'park', 'shop', 'school'], selectionMode: 'multi' },
];

describe('compiled SQL parameters run on DuckDB', () => {
  it.each([
    [['cafe', 'park'], 200],
    [[], 0], // nothing selected → empty result, not an SQL error
  ])('Category %j → %i rows', async (value, count) => {
    const { source, queryParameters } = compileQuery('SELECT * FROM demo_points WHERE category IN {{kinds}}', kinds(value));
    const tj = await vectorQuerySource({ ...common, sqlQuery: source, queryParameters: (queryParameters ?? undefined) as QueryParameters | undefined });
    expect(tj).toMatchObject({ tilestats: { layers: [{ count }] } });
  });
});
