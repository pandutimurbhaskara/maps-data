import type { LayerDescriptor } from '@carto/api-client';
import { MVTLoader } from '@loaders.gl/mvt';
import { describe, expect, it } from 'vitest';
import { withLocalLoaders } from './toDeckLayers';

const d = (type: string) => ({ type, props: { id: type, loadOptions: { fetch: { headers: { a: 'b' } } } } }) as unknown as LayerDescriptor;

describe('withLocalLoaders', () => {
  it('parses MVT in-page and disables CDN workers', () => {
    const v = withLocalLoaders(d('tileset')).props as { loaders: unknown[]; loadOptions: { worker: boolean; fetch: unknown } };
    expect(v.loaders).toContain(MVTLoader);
    expect(v.loadOptions).toEqual({ fetch: { headers: { a: 'b' } }, worker: false });
    const h = withLocalLoaders(d('h3')).props as { loaders?: unknown[]; loadOptions: { worker: boolean } };
    expect(h.loaders).toBeUndefined();
    expect(h.loadOptions.worker).toBe(false);
  });
});
