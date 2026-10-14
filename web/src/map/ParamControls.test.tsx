import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SqlParameter } from '../lib/mapDoc';
import { ParamControls } from './ParamControls';

const kinds: SqlParameter = { id: 'k', type: 'Category', name: 'Kinds', item: { sqlName: 'kinds', value: ['cafe'] }, values: ['cafe', 'park'], selectionMode: 'multi' };
const min: SqlParameter = { id: 'n', type: 'Numeric', name: 'Min value', item: { sqlName: 'min_value', value: 5 }, min: 0, max: 10, step: 1 };
const when: SqlParameter = { id: 'd', type: 'DateRange', name: 'When', start: { sqlName: 'when_from', value: '2026-01-01' }, end: { sqlName: 'when_to', value: '2026-01-31' } };

describe('ParamControls', () => {
  it('toggles category values, including deselecting all', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ParamControls params={[kinds]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Kinds: park'));
    expect(onChange).toHaveBeenLastCalledWith({ ...kinds, item: { sqlName: 'kinds', value: ['cafe', 'park'] } });
    rerender(<ParamControls params={[kinds]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Kinds: cafe'));
    expect(onChange).toHaveBeenLastCalledWith({ ...kinds, item: { sqlName: 'kinds', value: [] } });
  });

  it('edits numeric and date parameters', () => {
    const onChange = vi.fn();
    render(<ParamControls params={[min, when]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Min value'), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...min, item: { sqlName: 'min_value', value: 7 } });
    fireEvent.change(screen.getByLabelText('When to'), { target: { value: '2026-02-15' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...when, end: { sqlName: 'when_to', value: '2026-02-15' } });
  });
});
