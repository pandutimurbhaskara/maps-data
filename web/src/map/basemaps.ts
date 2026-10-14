// OSM-derived basemaps (OpenFreeMap, no key). Keys mirror the styleIds stored in map documents (ledger D11).
const BASEMAPS: Record<string, string> = {
  positron: 'https://tiles.openfreemap.org/styles/positron',
  'dark-matter': 'https://tiles.openfreemap.org/styles/dark',
  voyager: 'https://tiles.openfreemap.org/styles/liberty',
};

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

export function basemapStyle(styleId?: string): string {
  return BASEMAPS[styleId ?? ''] ?? BASEMAPS.positron;
}
