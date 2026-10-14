// CARTO-shaped map document (ledger D1–D10, spec M2 D2). parseMap() in @carto/api-client reads this shape.
import type { Filters } from '@carto/api-client';

export type Privacy = 'private' | 'shared' | 'public';
export type RGB = [number, number, number];
export type ScaleType = 'quantize' | 'quantile' | 'ordinal' | 'custom' | 'identity';

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
  dragRotate?: boolean;
}

export interface ColorRange {
  name: string;
  type: string;
  category: string;
  colors: string[];
}

export interface VisConfig {
  opacity: number;
  strokeOpacity: number;
  thickness: number;
  strokeColor: RGB | null;
  colorRange: ColorRange;
  strokeColorRange: ColorRange;
  radius: number;
  radiusRange: [number, number];
  sizeRange: [number, number];
  filled: boolean;
  stroked: boolean;
  enable3d: boolean;
  elevationScale: number;
  heightRange: [number, number];
  wireframe: boolean;
  sizeMinPixels: number;
  sizeMaxPixels: number;
  radiusScaleWithZoom: boolean;
  radiusReferenceZoom: number;
  customMarkers: boolean;
  customMarkersUrl: string;
  customMarkerSize: number;
  customMarkerSizeRange: [number, number];
  colorAggregation: string | null;
  colorAggregationExp: string | null;
  colorAggregationDomain: number[] | null;
  strokeColorAggregation: string | null;
  sizeAggregation: string | null;
  radiusAggregation: string | null;
  heightAggregation: string | null;
}

export interface FieldRef {
  name: string;
  type: string;
}

export interface VisualChannels {
  colorField: FieldRef | null;
  colorScale: ScaleType;
  strokeColorField: FieldRef | null;
  strokeColorScale: ScaleType;
  sizeField: FieldRef | null;
  sizeScale: string;
  radiusField: FieldRef | null;
  radiusScale: string;
  heightField: FieldRef | null;
  heightScale: string;
  rotationField: FieldRef | null;
  customMarkersField: FieldRef | null;
}

export interface TextLabel {
  field: FieldRef | null;
  color: RGB;
  size: number;
  offset: [number, number];
  anchor: string;
  alignment: string;
  outlineColor: RGB;
}

export interface LayerDoc {
  id: string;
  type: 'tileset' | 'h3';
  config: {
    dataId: string;
    label: string;
    color: RGB;
    isVisible: boolean;
    hidden: boolean;
    columns: Record<string, unknown>;
    highlightColor: number[];
    textLabel: TextLabel[];
    visConfig: VisConfig;
  };
  visualChannels: VisualChannels;
}

export type WidgetType = 'formula' | 'category' | 'histogram' | 'range' | 'table' | 'timeseries';
export type Operation = 'count' | 'avg' | 'min' | 'max' | 'sum';

export interface WidgetDoc {
  id: string;
  type: WidgetType;
  title: string;
  dataSource: string;
  column: string;
  operation: Operation;
  operationColumn?: string;
  ticks?: number[];
  stepSize?: 'year' | 'month' | 'week' | 'day' | 'hour';
  columns?: string[];
}

export interface CategoryParam {
  id: string;
  type: 'Category';
  name: string;
  item: { sqlName: string; value: string[] };
  values: string[];
  selectionMode: 'single' | 'multi';
}
export interface NumericParam {
  id: string;
  type: 'Numeric';
  name: string;
  item: { sqlName: string; value: number };
  min: number;
  max: number;
  step: number;
}
export interface NumericRangeParam {
  id: string;
  type: 'NumericRange';
  name: string;
  start: { sqlName: string; value: number };
  end: { sqlName: string; value: number };
  min: number;
  max: number;
  step: number;
}
export interface DateRangeParam {
  id: string;
  type: 'DateRange';
  name: string;
  start: { sqlName: string; value: string };
  end: { sqlName: string; value: string };
}
export type SqlParameter = CategoryParam | NumericParam | NumericRangeParam | DateRangeParam;

export interface PopupField {
  name: string;
}

export interface MapConfig {
  mapState: MapState;
  mapStyle: { styleType: string; visibleLayerGroups: Record<string, boolean> };
  basemapConfig: { styleId: string };
  visState: {
    layers: LayerDoc[];
    layerBlending: string;
    filters: unknown[];
    interactionConfig: {
      tooltip: { enabled: boolean; fieldsToShow: Record<string, unknown> };
      brush: { enabled: boolean; size: number };
    };
    animationConfig: { currentTime: number | null; speed: number };
    splitMaps: unknown[];
  };
  filters: Record<string, Filters>;
  widgets: WidgetDoc[];
  sqlParameters: SqlParameter[];
  popupSettings: { layers: Record<string, { click?: { fields: PopupField[] } }> };
  legendSettings: { layers: Record<string, unknown> };
  mapSettings: { sqlParameterControls: boolean };
  layerGrouping: unknown[];
}

export interface KeplerMapConfig {
  version: 'v1';
  config: MapConfig;
}

export interface MapDoc extends MapSummary {
  keplerMapConfig: KeplerMapConfig;
}

export interface DatasetDoc {
  id: string;
  type: 'table' | 'query';
  label: string;
  connectionName: string;
  source: string;
  geoColumn: string; // "geom" or "h3:<col>" (CARTO convention)
  columns: string[];
  queryTemplate: string | null;
  queryParameters: Record<string, unknown> | null;
  aggregationExp: string | null;
  aggregationResLevel: number | null;
  format: 'tilejson';
}
