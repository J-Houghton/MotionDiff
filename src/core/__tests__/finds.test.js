import { describe, expect, it } from 'vitest';
import { FIND_LOOKS, FIND_MAX_AGE, findBound, findOpacity, lookPeriod } from '../finds.js';

describe('findBound', () => {
  it('is a few look periods while looks are fast', () => {
    expect(findBound(0.25)).toBeCloseTo(FIND_LOOKS * 0.25);
    expect(findBound(0.4)).toBeCloseTo(1.2);
  });

  it('is capped: slow looks do not buy a find a longer life', () => {
    expect(findBound(2)).toBe(FIND_MAX_AGE);
    expect(findBound(60)).toBe(FIND_MAX_AGE);
  });

  it('falls back to the cap before the look rate is known', () => {
    expect(findBound(null)).toBe(FIND_MAX_AGE);
    expect(findBound(0)).toBe(FIND_MAX_AGE);
    expect(findBound(NaN)).toBe(FIND_MAX_AGE);
  });
});

describe('findOpacity', () => {
  const bound = 1.2; // looks every 0.4 s: full until 0.8 s, gone at 1.2 s

  it('a fresh find is drawn at full strength', () => {
    expect(findOpacity(0.4, 0.4, bound)).toBe(1);
    expect(findOpacity(0.8, 0.4, bound)).toBe(1);
  });

  it('then fades in a straight line to nothing, not to a floor', () => {
    expect(findOpacity(1.0, 0.4, bound)).toBeCloseTo(0.5);
    expect(findOpacity(1.19, 0.4, bound)).toBeLessThan(0.05);
    expect(findOpacity(1.2, 0.4, bound)).toBe(0);
  });

  it('is dropped once older than the bound, for good', () => {
    expect(findOpacity(1.3, 0.4, bound)).toBe(0);
    expect(findOpacity(40, 0.4, bound)).toBe(0);
  });

  it('a find that arrived stale is never drawn, even at the moment it arrives', () => {
    // The CPU rung: a look takes 1.9 s, the cap is 1.5 s. The answer is
    // about a picture nobody is looking at any more.
    expect(findOpacity(1.9, 1.9, FIND_MAX_AGE)).toBe(0);
    // Arrived inside the bound but already in its fade: it would only
    // blink, so it is not drawn either.
    expect(findOpacity(1.3, 1.3, FIND_MAX_AGE)).toBe(0);
    expect(findOpacity(1.31, 1.3, FIND_MAX_AGE)).toBe(0);
  });

  it('a find that arrived in time lives out its whole life', () => {
    expect(findOpacity(0.9, 0.9, FIND_MAX_AGE)).toBe(1);
    expect(findOpacity(1.25, 0.9, FIND_MAX_AGE)).toBeCloseTo(0.5);
  });

  it('draws nothing without a clock', () => {
    expect(findOpacity(NaN, 0.4, bound)).toBe(0);
    expect(findOpacity(0.4, NaN, bound)).toBe(0);
  });
});

describe('lookPeriod', () => {
  it('is the median gap between looks', () => {
    expect(lookPeriod([0, 0.4, 0.8, 1.3, 1.7])).toBeCloseTo(0.4);
  });

  it('one slow look does not move it', () => {
    expect(lookPeriod([0, 0.4, 0.8, 3.8, 4.2])).toBeCloseTo(0.4);
  });

  it('a pause, a seek back or a loop is not a gap between looks', () => {
    // Paused (same time twice), then the clip looped from 27 s to 0.3 s.
    expect(lookPeriod([26.2, 26.6, 26.6, 27.0, 0.3, 0.7])).toBeCloseTo(0.4);
  });

  it('is unknown until two looks are a step apart', () => {
    expect(lookPeriod([])).toBeNull();
    expect(lookPeriod([3])).toBeNull();
    expect(lookPeriod([3, 3])).toBeNull();
  });
});
