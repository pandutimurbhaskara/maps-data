import { describe, expect, it } from 'vitest';
import { newDataset, newLayer, newMapConfig } from '../lib/defaults';
import type { MapDoc } from '../lib/mapDoc';
import { prepareMap } from './prepareMap';

describe('prepareMap', () => {
  it('drops layers whose dataset was not passed in (e.g. a source with a compile error)', async () => {
    const broken = newDataset({ type: 'query', source: 'SELECT h3 FROM t WHERE a IN {{missing}}', geoColumn: 'h3:h3', label: 'Q' });
    const k = newMapConfig();
    k.config.visState.layers = [newLayer('h3', broken, 0)];
    const doc = { id: 'm', title: 'm', keplerMapConfig: k } as unknown as MapDoc;
    const prepared = await prepareMap(doc, [], { apiBaseUrl: 'http://x', accessToken: 't' });
    expect(prepared.parsed.layers).toEqual([]);
  });
});
