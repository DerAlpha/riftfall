/**
 * Allocation-free partial buffer uploads. BufferAttribute.addUpdateRange() pushes a new object
 * per call; here one range object PER ATTRIBUTE is reused (three reads it on upload and then
 * clears the list, so a single entry is always valid). Never share a range between attributes.
 */
import type * as THREE from 'three';

export interface UpdateRange {
  start: number;
  count: number;
}

/** Replace the attribute's update ranges with [start, start + count) (array elements). */
export function setUpdateRange(
  attr: THREE.BufferAttribute | THREE.InstancedBufferAttribute,
  range: UpdateRange,
  start: number,
  count: number,
): void {
  const ranges = attr.updateRanges;
  ranges.length = 0;
  range.start = start;
  range.count = count;
  ranges.push(range);
}

/**
 * Add a range, merging with the single pending range when possible (keeps at most one entry per
 * attribute for scattered single-slot writes such as decal/casing instances within one frame).
 */
export function addUpdateRange(
  attr: THREE.BufferAttribute | THREE.InstancedBufferAttribute,
  range: UpdateRange,
  start: number,
  count: number,
): void {
  const ranges = attr.updateRanges;
  if (ranges.length === 1 && ranges[0] === range) {
    const end = Math.max(range.start + range.count, start + count);
    range.start = Math.min(range.start, start);
    range.count = end - range.start;
    return;
  }
  ranges.length = 0;
  range.start = start;
  range.count = count;
  ranges.push(range);
}
