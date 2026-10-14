import { expect, it } from 'vitest';
import { hexToRgb, rgbToHex } from './color';

it('converts between hex and rgb', () => {
  expect(rgbToHex([18, 147, 154])).toBe('#12939a');
  expect(hexToRgb('#12939a')).toEqual([18, 147, 154]);
  expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
});
