import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Popup, popupRows } from './Popup';

it('builds rows from feature properties and closes', () => {
  expect(popupRows({ properties: { name: '東京駅', value: 1234.567, x: 1 } }, ['name', 'value', 'missing'])).toEqual([
    { name: 'name', value: '東京駅' },
    { name: 'value', value: '1,234.57' },
  ]);
  expect(popupRows({ id: 'cell', properties: { n: 3 } }, ['n'])).toEqual([{ name: 'n', value: '3' }]);
  const onClose = vi.fn();
  render(<Popup popup={{ x: 10, y: 20, title: 'Points', rows: [{ name: 'name', value: 'a' }] }} onClose={onClose} />);
  expect(screen.getByRole('dialog', { name: 'Points' })).toHaveTextContent('a');
  fireEvent.click(screen.getByRole('button', { name: 'Close popup' }));
  expect(onClose).toHaveBeenCalled();
});
