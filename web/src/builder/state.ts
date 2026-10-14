import type { Filters } from '@carto/api-client';
import { buildAggregationExp } from '../lib/aggregation';
import { normalizeConfig, normalizeDataset } from '../lib/defaults';
import type { DatasetDoc, LayerDoc, MapConfig, MapDoc, MapState, SqlParameter, WidgetDoc } from '../lib/mapDoc';
import { compileQuery } from '../lib/sqlParams';

export interface BuilderState {
  map: MapDoc;
  datasets: DatasetDoc[];
  errors: Record<string, string>;
  rev: { map: number; datasets: Record<string, number> };
  saved: { map: number; datasets: Record<string, number> };
  deleted: string[];
}

export type Action =
  | { type: 'renameMap'; title: string }
  | { type: 'setMapState'; mapState: MapState }
  | { type: 'setBasemap'; styleId: string }
  | { type: 'addDataset'; dataset: DatasetDoc }
  | { type: 'updateDataset'; id: string; patch: Partial<DatasetDoc> }
  | { type: 'removeDataset'; id: string }
  | { type: 'addLayer'; layer: LayerDoc }
  | { type: 'updateLayer'; id: string; update: (l: LayerDoc) => LayerDoc }
  | { type: 'removeLayer'; id: string }
  | { type: 'moveLayer'; id: string; delta: -1 | 1 }
  | { type: 'setPopupFields'; layerId: string; fields: string[] }
  | { type: 'addWidget'; widget: WidgetDoc }
  | { type: 'updateWidget'; id: string; patch: Partial<WidgetDoc> }
  | { type: 'removeWidget'; id: string }
  | { type: 'setFilters'; datasetId: string; filters: Filters }
  | { type: 'addSqlParameter'; param: SqlParameter }
  | { type: 'updateSqlParameter'; param: SqlParameter }
  | { type: 'removeSqlParameter'; id: string }
  | { type: 'saved'; map: number; datasets: Record<string, number>; deleted: string[] };

export function initState(map: MapDoc, datasets: DatasetDoc[]): BuilderState {
  const s: BuilderState = {
    map: { ...map, keplerMapConfig: normalizeConfig(map.keplerMapConfig) },
    datasets: datasets.map(normalizeDataset),
    errors: {},
    rev: { map: 0, datasets: {} },
    saved: { map: 0, datasets: {} },
    deleted: [],
  };
  const derived = derive(s);
  // what was loaded is what the server has: derived changes on load are saved with the first edit
  return { ...derived, saved: { map: 0, datasets: { ...derived.rev.datasets } } };
}

export const dirtyDatasets = (s: BuilderState) => s.datasets.filter((d) => (s.rev.datasets[d.id] ?? 0) > (s.saved.datasets[d.id] ?? 0));

export const hasChanges = (s: BuilderState) => s.rev.map > s.saved.map || s.deleted.length > 0 || dirtyDatasets(s).length > 0;

function editConfig(s: BuilderState, edit: (c: MapConfig) => MapConfig): BuilderState {
  const config = edit(s.map.keplerMapConfig.config);
  return { ...s, map: { ...s.map, keplerMapConfig: { ...s.map.keplerMapConfig, config } }, rev: { ...s.rev, map: s.rev.map + 1 } };
}

const editLayers = (s: BuilderState, edit: (ls: LayerDoc[]) => LayerDoc[]) =>
  editConfig(s, (c) => ({ ...c, visState: { ...c.visState, layers: edit(c.visState.layers) } }));

function bumpDataset(s: BuilderState, id: string): BuilderState {
  return { ...s, rev: { ...s.rev, datasets: { ...s.rev.datasets, [id]: (s.rev.datasets[id] ?? 0) + 1 } } };
}

function withoutOwner(filters: Filters, owner: string): Filters {
  const out: Filters = {};
  for (const [col, byType] of Object.entries(filters)) {
    const kept = Object.fromEntries(Object.entries(byType).filter(([, f]) => (f as { owner?: string } | undefined)?.owner !== owner));
    if (Object.keys(kept).length) out[col] = kept as Filters[string];
  }
  return out;
}

function reduce(s: BuilderState, a: Action): BuilderState {
  switch (a.type) {
    case 'renameMap':
      return { ...s, map: { ...s.map, title: a.title }, rev: { ...s.rev, map: s.rev.map + 1 } };
    case 'setMapState':
      return editConfig(s, (c) => ({ ...c, mapState: { ...c.mapState, ...a.mapState } }));
    case 'setBasemap':
      return editConfig(s, (c) => ({ ...c, basemapConfig: { styleId: a.styleId }, mapStyle: { ...c.mapStyle, styleType: a.styleId } }));
    case 'addDataset':
      return bumpDataset({ ...s, datasets: [...s.datasets, a.dataset], deleted: s.deleted.filter((id) => id !== a.dataset.id) }, a.dataset.id);
    case 'updateDataset':
      return bumpDataset({ ...s, datasets: s.datasets.map((d) => (d.id === a.id ? { ...d, ...a.patch, id: d.id } : d)) }, a.id);
    case 'removeDataset': {
      const next = editConfig(s, (c) => {
        const filters = { ...c.filters };
        delete filters[a.id];
        return {
          ...c,
          filters,
          visState: { ...c.visState, layers: c.visState.layers.filter((l) => l.config.dataId !== a.id) },
          widgets: c.widgets.filter((w) => w.dataSource !== a.id),
        };
      });
      const errors = { ...next.errors };
      delete errors[a.id];
      return { ...next, errors, datasets: next.datasets.filter((d) => d.id !== a.id), deleted: [...next.deleted, a.id] };
    }
    case 'addLayer':
      return editLayers(s, (ls) => [a.layer, ...ls]); // kepler order: index 0 is the top layer
    case 'updateLayer':
      return editLayers(s, (ls) => ls.map((l) => (l.id === a.id ? a.update(l) : l)));
    case 'removeLayer': {
      const next = editLayers(s, (ls) => ls.filter((l) => l.id !== a.id));
      return editConfig(next, (c) => {
        const layers = { ...c.popupSettings.layers };
        delete layers[a.id];
        return { ...c, popupSettings: { layers } };
      });
    }
    case 'moveLayer':
      return editLayers(s, (ls) => {
        const i = ls.findIndex((l) => l.id === a.id);
        const j = i + a.delta;
        if (i < 0 || j < 0 || j >= ls.length) return ls;
        const out = [...ls];
        [out[i], out[j]] = [out[j], out[i]];
        return out;
      });
    case 'setPopupFields':
      return editConfig(s, (c) => ({
        ...c,
        popupSettings: { layers: { ...c.popupSettings.layers, [a.layerId]: { click: { fields: a.fields.map((name) => ({ name })) } } } },
      }));
    case 'addWidget':
      return editConfig(s, (c) => ({ ...c, widgets: [...c.widgets, a.widget] }));
    case 'updateWidget':
      return editConfig(s, (c) => ({ ...c, widgets: c.widgets.map((w) => (w.id === a.id ? { ...w, ...a.patch, id: w.id } : w)) }));
    case 'removeWidget':
      return editConfig(s, (c) => ({
        ...c,
        widgets: c.widgets.filter((w) => w.id !== a.id),
        filters: Object.fromEntries(Object.entries(c.filters).map(([ds, f]) => [ds, withoutOwner(f, a.id)])),
      }));
    case 'setFilters':
      return editConfig(s, (c) => ({ ...c, filters: { ...c.filters, [a.datasetId]: a.filters } }));
    case 'addSqlParameter':
      return editConfig(s, (c) => ({ ...c, sqlParameters: [...c.sqlParameters, a.param] }));
    case 'updateSqlParameter':
      return editConfig(s, (c) => ({ ...c, sqlParameters: c.sqlParameters.map((p) => (p.id === a.param.id ? a.param : p)) }));
    case 'removeSqlParameter':
      return editConfig(s, (c) => ({ ...c, sqlParameters: c.sqlParameters.filter((p) => p.id !== a.id) }));
    case 'saved':
      return {
        ...s,
        saved: { map: Math.max(s.saved.map, a.map), datasets: { ...s.saved.datasets, ...a.datasets } },
        deleted: s.deleted.filter((id) => !a.deleted.includes(id)),
      };
  }
}

// columnsFor lists the fields a tileset dataset must put in its tiles: styled channels and popup fields.
function columnsFor(datasetId: string, c: MapConfig): string[] {
  const cols = new Set<string>();
  for (const l of c.visState.layers) {
    if (l.config.dataId !== datasetId) continue;
    const ch = l.visualChannels;
    for (const f of [ch.colorField, ch.strokeColorField, ch.sizeField, ch.radiusField]) if (f) cols.add(f.name);
    for (const f of c.popupSettings.layers[l.id]?.click?.fields ?? []) cols.add(f.name);
  }
  return [...cols].sort();
}

// derive recomputes compiled SQL, H3 aggregationExp and tile columns; changed datasets get their rev bumped.
function derive(s: BuilderState): BuilderState {
  const c = s.map.keplerMapConfig.config;
  const errors = { ...s.errors };
  let out = s;
  const datasets = s.datasets.map((d) => {
    const next = { ...d };
    if (d.queryTemplate) {
      try {
        Object.assign(next, compileQuery(d.queryTemplate, c.sqlParameters));
        delete errors[d.id];
      } catch (e) {
        errors[d.id] = (e as Error).message;
      }
    }
    if (d.geoColumn.startsWith('h3:')) next.aggregationExp = buildAggregationExp(d.id, c.visState.layers);
    else next.columns = columnsFor(d.id, c);
    if (JSON.stringify(next) !== JSON.stringify(d)) out = bumpDataset(out, d.id);
    return next;
  });
  return { ...out, datasets, errors };
}

export function builderReducer(s: BuilderState, a: Action): BuilderState {
  const next = reduce(s, a);
  return a.type === 'saved' ? next : derive(next);
}
