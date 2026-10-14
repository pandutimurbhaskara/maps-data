import * as cartocolor from 'cartocolor';
import type { ColorRange, DatasetDoc, KeplerMapConfig, LayerDoc, MapConfig, MapState, RGB, WidgetDoc, WidgetType } from './mapDoc';

export const newId = (): string => crypto.randomUUID();

// CARTOColors (CC BY 4.0) — the builder palette picker shows that credit.
export const PALETTES = ['Sunset', 'SunsetDark', 'Teal', 'TealGrn', 'Emrld', 'BluYl', 'Burg', 'Peach', 'PurpOr', 'Magenta', 'Mint', 'Bold', 'Vivid', 'Prism', 'Safe', 'Pastel'];

const palettes = cartocolor as unknown as Record<string, Record<string, string[]> & { tags?: string[] }>;

export function colorRange(name: string, n = 6): ColorRange {
  const p = palettes[name] ?? palettes.Sunset;
  const sizes = Object.keys(p).filter((k) => /^\d+$/.test(k)).map(Number);
  const size = sizes.includes(n) ? n : Math.max(...sizes.filter((s) => s <= Math.max(n, 2)), Math.min(...sizes));
  const tags = p.tags ?? [];
  const type = tags.includes('qualitative') ? 'qualitative' : tags.includes('diverging') ? 'diverging' : 'sequential';
  return { name: palettes[name] ? name : 'Sunset', type, category: 'CARTO', colors: [...p[String(size)]] };
}

export const LAYER_COLORS: RGB[] = [[18, 147, 154], [242, 108, 67], [106, 61, 154], [230, 171, 2], [29, 105, 150], [217, 95, 2]];

export function newMapConfig(mapState: MapState = { latitude: 35.681, longitude: 139.767, zoom: 11 }): KeplerMapConfig {
  const config: MapConfig = {
    mapState: { pitch: 0, bearing: 0, dragRotate: false, ...mapState },
    mapStyle: { styleType: 'positron', visibleLayerGroups: {} },
    basemapConfig: { styleId: 'positron' },
    visState: {
      layers: [],
      layerBlending: 'normal',
      filters: [],
      interactionConfig: { tooltip: { enabled: true, fieldsToShow: {} }, brush: { enabled: false, size: 0.5 } },
      animationConfig: { currentTime: null, speed: 1 },
      splitMaps: [],
    },
    filters: {},
    widgets: [],
    sqlParameters: [],
    popupSettings: { layers: {} },
    legendSettings: { layers: {} },
    mapSettings: { sqlParameterControls: true },
    layerGrouping: [],
  };
  return { version: 'v1', config };
}

// normalizeConfig fills every key parseMap() reads, so M1 documents (minimal config) load in the builder.
export function normalizeConfig(k: Partial<KeplerMapConfig> | null | undefined): KeplerMapConfig {
  const base = newMapConfig(k?.config?.mapState).config;
  const c = (k?.config ?? {}) as Partial<MapConfig>;
  const vs = (c.visState ?? {}) as Partial<MapConfig['visState']>;
  return {
    version: 'v1',
    config: {
      ...base,
      ...c,
      mapState: { ...base.mapState, ...c.mapState },
      mapStyle: { ...base.mapStyle, ...c.mapStyle },
      basemapConfig: { ...base.basemapConfig, ...c.basemapConfig },
      visState: {
        ...base.visState,
        ...vs,
        layers: (vs.layers ?? []).map(normalizeLayer),
        interactionConfig: { ...base.visState.interactionConfig, ...vs.interactionConfig },
      },
      filters: c.filters ?? {},
      widgets: c.widgets ?? [],
      sqlParameters: c.sqlParameters ?? [],
      popupSettings: { layers: c.popupSettings?.layers ?? {} },
      legendSettings: { layers: c.legendSettings?.layers ?? {} },
      mapSettings: { ...base.mapSettings, ...c.mapSettings },
      layerGrouping: c.layerGrouping ?? [],
    },
  };
}

// normalizeLayer fills the CARTO layer keys parseMap() reads into partial (e.g. M1, hand-written) layers.
export function normalizeLayer(l: LayerDoc): LayerDoc {
  const partial = l as Partial<LayerDoc> & { config?: Partial<LayerDoc['config']> };
  const type = partial.type === 'h3' ? 'h3' : 'tileset';
  const base = newLayer(type, { id: partial.config?.dataId ?? '', label: partial.config?.label ?? '' } as DatasetDoc, 0);
  return {
    ...base,
    ...partial,
    id: partial.id ?? base.id,
    type,
    config: {
      ...base.config,
      ...partial.config,
      visConfig: { ...base.config.visConfig, ...partial.config?.visConfig },
    },
    visualChannels: { ...base.visualChannels, ...partial.visualChannels },
  };
}

export function newDataset(init: Pick<DatasetDoc, 'type' | 'source' | 'geoColumn' | 'label'> & Partial<DatasetDoc>): DatasetDoc {
  return {
    id: newId(),
    connectionName: 'osm',
    columns: [],
    queryTemplate: null,
    queryParameters: null,
    aggregationExp: null,
    aggregationResLevel: init.geoColumn.startsWith('h3:') ? 4 : null,
    format: 'tilejson',
    ...init,
  };
}

export function newLayer(type: 'tileset' | 'h3', dataset: DatasetDoc, index: number): LayerDoc {
  return {
    id: newId(),
    type,
    config: {
      dataId: dataset.id,
      label: dataset.label,
      color: LAYER_COLORS[index % LAYER_COLORS.length],
      isVisible: true,
      hidden: false,
      columns: {},
      highlightColor: [252, 242, 26, 255],
      textLabel: [{ field: null, color: [255, 255, 255], size: 12, offset: [0, 0], anchor: 'start', alignment: 'center', outlineColor: [0, 0, 0] }],
      visConfig: {
        opacity: 0.8,
        strokeOpacity: 0.8,
        thickness: 1,
        strokeColor: null,
        colorRange: colorRange('Sunset'),
        strokeColorRange: colorRange('Sunset'),
        radius: 4,
        radiusRange: [0, 50],
        sizeRange: [0, 10],
        filled: true,
        stroked: type === 'tileset',
        enable3d: false,
        elevationScale: 5,
        heightRange: [0, 500],
        wireframe: false,
        sizeMinPixels: 2,
        sizeMaxPixels: 100,
        radiusScaleWithZoom: false,
        radiusReferenceZoom: 12,
        customMarkers: false,
        customMarkersUrl: '',
        customMarkerSize: 2,
        customMarkerSizeRange: [0, 50],
        colorAggregation: type === 'h3' ? 'sum' : null,
        colorAggregationExp: null,
        colorAggregationDomain: null,
        strokeColorAggregation: null,
        sizeAggregation: null,
        radiusAggregation: null,
        heightAggregation: null,
      },
    },
    visualChannels: {
      colorField: null,
      colorScale: 'quantize',
      strokeColorField: null,
      strokeColorScale: 'quantile',
      sizeField: null,
      sizeScale: 'linear',
      radiusField: null,
      radiusScale: 'linear',
      heightField: null,
      heightScale: 'linear',
      rotationField: null,
      customMarkersField: null,
    },
  };
}

const WIDGET_TITLES: Record<WidgetType, string> = {
  formula: 'Total',
  category: 'Categories',
  histogram: 'Distribution',
  range: 'Range',
  table: 'Table',
  timeseries: 'Over time',
};

export function newWidget(type: WidgetType, dataSource: string, column: string, title?: string): WidgetDoc {
  return {
    id: newId(),
    type,
    title: title ?? WIDGET_TITLES[type],
    dataSource,
    column,
    operation: 'count',
    ...(type === 'timeseries' ? { stepSize: 'day' as const } : {}),
    ...(type === 'table' ? { columns: [column] } : {}),
  };
}
