import { act, renderHook } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newDataset, newMapConfig } from '../lib/defaults';
import type { MapDoc } from '../lib/mapDoc';
import { builderReducer, initState } from './state';
import { useAutosave, type SaveApi } from './useAutosave';

const map = { id: 'm', title: 'T', keplerMapConfig: newMapConfig() } as unknown as MapDoc;

function setup(api: SaveApi) {
  return renderHook(() => {
    const [state, dispatch] = useReducer(builderReducer, initState(map, []));
    const status = useAutosave(state, dispatch, api, 800);
    return { state, dispatch, status };
  });
}

describe('useAutosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst of edits into one save of the latest state', async () => {
    const api = { patchMap: vi.fn(async () => ({})), saveDataset: vi.fn(async () => ({})), deleteDataset: vi.fn(async () => {}) };
    const { result } = setup(api);
    act(() => result.current.dispatch({ type: 'renameMap', title: 'A' }));
    act(() => result.current.dispatch({ type: 'renameMap', title: 'AB' }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(api.patchMap).toHaveBeenCalledTimes(1);
    expect(api.patchMap).toHaveBeenCalledWith('m', expect.objectContaining({ title: 'AB' }));
    expect(result.current.status).toBe('saved');
  });

  it('saves an edit made during an in-flight save afterwards, without losing it', async () => {
    let release!: () => void;
    const api = {
      patchMap: vi.fn().mockImplementationOnce(() => new Promise<void>((r) => (release = r))).mockResolvedValue({}),
      saveDataset: vi.fn(async () => ({})),
      deleteDataset: vi.fn(async () => {}),
    };
    const { result } = setup(api);
    act(() => result.current.dispatch({ type: 'renameMap', title: 'first' }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    act(() => result.current.dispatch({ type: 'renameMap', title: 'second' }));
    await act(async () => vi.advanceTimersByTimeAsync(800)); // still in flight: must not start a second save
    expect(api.patchMap).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(api.patchMap).toHaveBeenCalledTimes(2);
    expect(api.patchMap).toHaveBeenLastCalledWith('m', expect.objectContaining({ title: 'second' }));
  });

  it('saves added datasets and deletes removed ones', async () => {
    const api = { patchMap: vi.fn(async () => ({})), saveDataset: vi.fn(async () => ({})), deleteDataset: vi.fn(async () => {}) };
    const { result } = setup(api);
    const ds = newDataset({ type: 'table', source: 'demo_points', geoColumn: 'geom', label: 'P' });
    act(() => result.current.dispatch({ type: 'addDataset', dataset: ds }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(api.saveDataset).toHaveBeenCalledWith('m', expect.objectContaining({ id: ds.id }));
    act(() => result.current.dispatch({ type: 'removeDataset', id: ds.id }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(api.deleteDataset).toHaveBeenCalledWith('m', ds.id);
  });

  it('reports errors and retries on the next edit', async () => {
    const api = { patchMap: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({}), saveDataset: vi.fn(), deleteDataset: vi.fn() };
    const { result } = setup(api);
    act(() => result.current.dispatch({ type: 'renameMap', title: 'x' }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(result.current.status).toBe('error');
    act(() => result.current.dispatch({ type: 'renameMap', title: 'y' }));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(result.current.status).toBe('saved');
  });

  it('flushes a pending edit when the builder unmounts (e.g. Preview) instead of dropping it', async () => {
    const api = { patchMap: vi.fn(async () => ({})), saveDataset: vi.fn(async () => ({})), deleteDataset: vi.fn(async () => {}) };
    const { result, unmount } = setup(api);
    act(() => result.current.dispatch({ type: 'renameMap', title: 'renamed' }));
    unmount();
    expect(api.patchMap).toHaveBeenCalledWith('m', expect.objectContaining({ title: 'renamed' }));
  });

  it('asks before leaving the page while changes are unsaved', async () => {
    const api = { patchMap: vi.fn(async () => ({})), saveDataset: vi.fn(async () => ({})), deleteDataset: vi.fn(async () => {}) };
    const { result } = setup(api);
    const leave = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(leave()).toBe(false);
    act(() => result.current.dispatch({ type: 'renameMap', title: 'unsaved' }));
    expect(leave()).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(leave()).toBe(false);
  });
});
