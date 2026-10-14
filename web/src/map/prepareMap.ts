import { _fillInMapDatasets, _fillInTileStats, parseMap, type WidgetSource } from '@carto/api-client';
import type { DatasetDoc, MapDoc } from '../lib/mapDoc';

export interface RenderContext {
  apiBaseUrl: string;
  accessToken: string;
}

export type LoadedDataset = DatasetDoc & {
  data: { tiles: string[]; widgetSource: WidgetSource; maxresolution?: number; schema?: { name: string; type: string }[] };
};

export interface PreparedMap {
  parsed: ReturnType<typeof parseMap>;
  datasets: LoadedDataset[];
  errors: Record<string, string>;
}

type FillContext = Parameters<typeof _fillInMapDatasets>[1];

// prepareMap runs CARTO's own map pipeline (spec M2 D1): sources → tilestats → parseMap.
// A dataset that fails to load (bad SQL, unknown column) is reported in `errors`; layers of any dataset that is
// not loaded (failed here, or left out by the caller) are dropped instead of failing the whole map.
export async function prepareMap(doc: MapDoc, datasets: DatasetDoc[], ctx: RenderContext): Promise<PreparedMap> {
  const keplerMapConfig = structuredClone(doc.keplerMapConfig);
  const copies = structuredClone(datasets) as LoadedDataset[];
  const errors: Record<string, string> = {};
  const fill = ctx as unknown as FillContext;
  await Promise.all(
    copies.map(async (d) => {
      try {
        await _fillInMapDatasets({ datasets: [d], keplerMapConfig } as never, fill);
      } catch (e) {
        errors[d.id] = (e as Error).message;
      }
    }),
  );
  const loaded = copies.filter((d) => !errors[d.id]);
  const loadedIds = new Set(loaded.map((d) => d.id));
  const json = {
    ...doc,
    keplerMapConfig: {
      ...keplerMapConfig,
      config: {
        ...keplerMapConfig.config,
        visState: {
          ...keplerMapConfig.config.visState,
          layers: keplerMapConfig.config.visState.layers.filter((l) => loadedIds.has(l.config.dataId)),
        },
      },
    },
    datasets: loaded,
  };
  try {
    await _fillInTileStats(json as never, fill);
  } catch (e) {
    // a stats failure must not hide the map; parseMap falls back to tilestats from the TileJSON
    errors.__stats = (e as Error).message;
  }
  return { parsed: parseMap(json), datasets: loaded, errors };
}
