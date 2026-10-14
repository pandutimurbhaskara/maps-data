import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GeocoderBox } from './GeocoderBox';

it('searches places and selects one', async () => {
  const place = { name: '東京駅', kind: 'station', longitude: 139.77, latitude: 35.68 };
  const fetcher = vi.fn(async (_u: RequestInfo | URL) => new Response(JSON.stringify({ rows: [place] })));
  const onSelect = vi.fn();
  render(<GeocoderBox fetcher={fetcher} onSelect={onSelect} />);
  fireEvent.change(screen.getByLabelText('Search places'), { target: { value: '東京' } });
  fireEvent.submit(screen.getByRole('search'));
  fireEvent.click(await screen.findByRole('button', { name: /東京駅/ }));
  expect(String(fetcher.mock.calls[0][0])).toBe('/v3/lds/geocoding/geocode?address=%E6%9D%B1%E4%BA%AC&limit=5');
  expect(onSelect).toHaveBeenCalledWith(place);
});
