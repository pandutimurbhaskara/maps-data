// Subset of the map document (spec §4.4, ledger D1) that M1 reads. Unknown keys are preserved by the server.
export type Privacy = 'private' | 'shared' | 'public';
export type RGB = [number, number, number];

export interface MapSummary {
  id: string;
  title: string;
  description: string;
  tags: string[];
  privacy: Privacy;
  collaborative: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl: string | null;
  views: number;
}

export interface MapState {
  latitude: number;
  longitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export interface LayerDoc {
  id: string;
  type: 'tileset' | 'h3' | string;
  config: {
    dataId: string;
    label?: string;
    color?: RGB;
    isVisible?: boolean;
    visConfig?: {
      opacity?: number;
      radius?: number;
      filled?: boolean;
      stroked?: boolean;
      strokeColor?: RGB | null;
      thickness?: number;
    };
  };
}

export interface KeplerMapConfig {
  version: 'v1';
  config: {
    mapState: MapState;
    visState?: { layers?: LayerDoc[] };
    basemapConfig?: { styleId?: string };
  };
}

export interface MapDoc extends MapSummary {
  keplerMapConfig: KeplerMapConfig;
}

export interface DatasetDoc {
  id: string;
  type: 'table' | 'query';
  label?: string;
  connectionName: string;
  source: string;
  geoColumn?: string | null;
  spatialIndex?: 'h3' | null;
  columns?: string[] | null;
  queryParameters?: Record<string, unknown> | null;
  aggregationExp?: string | null;
  aggregationResLevel?: number | null;
}
