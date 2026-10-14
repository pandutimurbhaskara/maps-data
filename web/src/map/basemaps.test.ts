import { describe, expect, it } from 'vitest';
import { basemapStyle } from './basemaps';

describe('basemapStyle', () => {
  it('maps CARTO-style ids to OSM-based OpenFreeMap styles', () => {
    expect(basemapStyle('positron')).toBe('https://tiles.openfreemap.org/styles/positron');
    expect(basemapStyle('dark-matter')).toBe('https://tiles.openfreemap.org/styles/dark');
    expect(basemapStyle('voyager')).toBe('https://tiles.openfreemap.org/styles/liberty');
  });
  it('falls back to positron for unknown or Google ids', () => {
    expect(basemapStyle(undefined)).toBe(basemapStyle('positron'));
    expect(basemapStyle('google-roadmap')).toBe(basemapStyle('positron'));
  });
});
