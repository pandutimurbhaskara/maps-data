import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ParamsPanel, slugify } from './ParamsPanel';
import type { Action } from './state';

describe('ParamsPanel', () => {
  it('adds a category parameter with all values selected', () => {
    const dispatch = vi.fn<(a: Action) => void>();
    render(<ParamsPanel params={[]} dispatch={dispatch} />);
    fireEvent.change(screen.getByLabelText('Parameter name'), { target: { value: 'Amenity kinds' } });
    fireEvent.change(screen.getByLabelText('Values (comma separated)'), { target: { value: 'cafe, restaurant ,bar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      type: 'addSqlParameter',
      param: { type: 'Category', name: 'Amenity kinds', item: { sqlName: 'amenity_kinds', value: ['cafe', 'restaurant', 'bar'] }, values: ['cafe', 'restaurant', 'bar'] },
    });
  });

  it('adds a numeric range with from/to names', () => {
    const dispatch = vi.fn<(a: Action) => void>();
    render(<ParamsPanel params={[]} dispatch={dispatch} />);
    fireEvent.change(screen.getByLabelText('Parameter type'), { target: { value: 'NumericRange' } });
    fireEvent.change(screen.getByLabelText('Parameter name'), { target: { value: 'Value' } });
    fireEvent.change(screen.getByLabelText('Minimum'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(dispatch.mock.calls[0][0]).toMatchObject({ param: { type: 'NumericRange', start: { sqlName: 'value_from', value: 0 }, end: { sqlName: 'value_to', value: 400 } } });
  });

  it('slugifies names into valid sqlNames', () => {
    expect(slugify('Amenity kinds')).toBe('amenity_kinds');
    expect(slugify('2nd value')).toBe('p2nd_value');
    expect(slugify('p__x')).toBe('param_p_x');
    expect(slugify('東京')).toBe('param');
  });
});
