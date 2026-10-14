import type { LayerDescriptor } from '@carto/api-client';
import { LayerFactory } from '@deck.gl/carto';
import { MVTLoader } from '@loaders.gl/mvt';

// M1 rulings: mapsd serves MVT, and loaders must not fetch worker scripts from a CDN.
export function withLocalLoaders(d: LayerDescriptor): LayerDescriptor {
  const props = d.props as Record<string, unknown> & { loadOptions?: Record<string, unknown> };
  return {
    ...d,
    props: {
      ...props,
      loadOptions: { ...(props.loadOptions ?? {}), worker: false },
      ...(d.type === 'tileset' ? { loaders: [MVTLoader] } : {}),
    } as LayerDescriptor['props'],
  };
}

export function toDeckLayers(descriptors: (LayerDescriptor | undefined)[]) {
  return descriptors.filter((d): d is LayerDescriptor => !!d).map((d) => LayerFactory(withLocalLoaders(d)));
}
