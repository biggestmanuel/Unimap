import { describe, it, expect } from 'vitest';
import { CATEGORIES, categoryMeta, normalizeCategory, RSU_CAMPUS_POLYGON } from './categories.js';

describe('normalizeCategory', () => {
  it('passes through known keys', () => {
    expect(normalizeCategory('hostel')).toBe('hostel');
    expect(normalizeCategory('lecture-hall')).toBe('lecture-hall');
  });

  it('trims the whitespace bug in the source data', () => {
    expect(normalizeCategory('laboratory ')).toBe('laboratory');
    expect(normalizeCategory('  hostel  ')).toBe('hostel');
  });

  it('lowercases', () => {
    expect(normalizeCategory('HOSTEL')).toBe('hostel');
  });

  it('collapses internal whitespace to dashes', () => {
    expect(normalizeCategory('lecture hall')).toBe('lecture-hall');
  });

  it('falls back to "other"', () => {
    expect(normalizeCategory('spaceport')).toBe('other');
    expect(normalizeCategory('')).toBe('other');
    expect(normalizeCategory(null)).toBe('other');
    expect(normalizeCategory(42)).toBe('other');
    expect(normalizeCategory(undefined)).toBe('other');
  });
});

describe('categoryMeta', () => {
  it('returns the full meta object', () => {
    const meta = categoryMeta('hostel');
    expect(meta.label).toBe('Hostel');
    expect(meta.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(meta.icon).toBeTruthy();
  });

  it('falls back for unknown keys', () => {
    expect(categoryMeta('spaceport').label).toBe('Other');
    expect(categoryMeta(undefined).label).toBe('Other');
  });

  it('has a label, colour and icon for every registered category', () => {
    for (const [key, meta] of Object.entries(CATEGORIES)) {
      expect(meta.label, key).toBeTruthy();
      expect(meta.color, key).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(meta.icon, key).toBeTruthy();
    }
  });

  it('uses unique keys', () => {
    expect(Object.keys(CATEGORIES).length).toBeGreaterThan(0);
    expect(new Set(Object.keys(CATEGORIES)).size).toBe(Object.keys(CATEGORIES).length);
  });
});

describe('RSU_CAMPUS_POLYGON', () => {
  it('is a closed [lat, lng] ring', () => {
    expect(Array.isArray(RSU_CAMPUS_POLYGON)).toBe(true);
    expect(RSU_CAMPUS_POLYGON.length).toBeGreaterThanOrEqual(4);
    for (const vertex of RSU_CAMPUS_POLYGON) {
      expect(vertex).toHaveLength(2);
      expect(Number.isFinite(vertex[0])).toBe(true);
      expect(Number.isFinite(vertex[1])).toBe(true);
    }
    const [first, last] = [RSU_CAMPUS_POLYGON[0], RSU_CAMPUS_POLYGON.at(-1)];
    expect(first).toEqual(last);
  });

  it('encloses the campus centroid', () => {
    const lats = RSU_CAMPUS_POLYGON.map((v) => v[0]);
    const lngs = RSU_CAMPUS_POLYGON.map((v) => v[1]);
    expect(4.797).toBeGreaterThanOrEqual(Math.min(...lats));
    expect(4.797).toBeLessThanOrEqual(Math.max(...lats));
    expect(6.982).toBeGreaterThanOrEqual(Math.min(...lngs));
    expect(6.982).toBeLessThanOrEqual(Math.max(...lngs));
  });
});