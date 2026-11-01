import { describe, expect, it } from 'vitest';
import { MARKER_CONFIG } from '@/constants/cesiumConfig';
import { fanOutOffsets, groupOverlapping } from './cesiumPinClusters';

describe('groupOverlapping', () => {
  it('leaves pins that are apart ungrouped', () => {
    expect(groupOverlapping([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 0 },
    ], 44)).toEqual([]);
  });

  it('groups pins closer than the distance, with sorted ids', () => {
    expect(groupOverlapping([
      { id: 'pirca12', x: 10, y: 10 },
      { id: 'pirca11', x: 20, y: 15 },
      { id: 'pirca0', x: 500, y: 500 },
    ], 44)).toEqual([['pirca11', 'pirca12']]);
  });

  it('does not group pins exactly at the distance', () => {
    expect(groupOverlapping([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 44, y: 0 },
    ], 44)).toEqual([]);
  });

  it('puts each pin in one group at most', () => {
    // b is within reach of both a and c, but a groups first and takes it
    const groups = groupOverlapping([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 30, y: 0 },
      { id: 'c', x: 60, y: 0 },
    ], 44);
    expect(groups).toEqual([['a', 'b']]);
  });

  it('forms separate groups in different places', () => {
    expect(groupOverlapping([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 5, y: 5 },
      { id: 'c', x: 300, y: 300 },
      { id: 'd', x: 310, y: 300 },
      { id: 'e', x: 305, y: 290 },
    ], 44)).toEqual([['a', 'b'], ['c', 'd', 'e']]);
  });
});

describe('fanOutOffsets', () => {
  it('starts every pin at the center', () => {
    for (const offset of fanOutOffsets(3, 0)) {
      expect(Math.abs(offset.x)).toBeLessThan(1e-9);
      expect(Math.abs(offset.y)).toBeLessThan(1e-9);
    }
  });

  it('puts the first pin to the left and spaces pins evenly on the ring', () => {
    const [first, second] = fanOutOffsets(2, 1);
    expect(first.x).toBeCloseTo(-MARKER_CONFIG.explodeRadius);
    expect(first.y).toBeCloseTo(0);
    expect(second.x).toBeCloseTo(MARKER_CONFIG.explodeRadius);
    expect(second.y).toBeCloseTo(0);
  });

  it('widens the ring for many pins', () => {
    const offsets = fanOutOffsets(8, 1);
    expect(offsets).toHaveLength(8);
    for (const offset of offsets) {
      expect(Math.hypot(offset.x, offset.y)).toBeCloseTo(Math.max(MARKER_CONFIG.explodeRadius, 80));
    }
  });
});
