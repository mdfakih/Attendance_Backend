import { describe, expect, it } from 'vitest';
import { checkGeofence, type GeofenceSite, haversineMeters } from './geofence.js';

const office: GeofenceSite = { id: 's1', name: 'Office', lat: 19.076, lng: 72.8777, radiusM: 100, maxAccuracyM: 100 };

describe('haversineMeters', () => {
  it('is zero for the same point and ~111 km per degree of latitude', () => {
    expect(haversineMeters(office, office)).toBe(0);
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -2);
  });
});

describe('checkGeofence', () => {
  it('accepts a fix inside the radius', () => {
    const result = checkGeofence({ lat: 19.0765, lng: 72.8777, accuracyM: 15 }, [office], 25);
    expect(result.ok).toBe(true);
  });

  it('uses the accuracy buffer, capped', () => {
    // ~120 m north: outside 100 m, inside with a 25 m buffer cap
    const fix = { lat: 19.07708, lng: 72.8777, accuracyM: 40 };
    expect(checkGeofence(fix, [office], 25).ok).toBe(true);
    expect(checkGeofence(fix, [office], 10).ok).toBe(false);
  });

  it('rejects far away fixes and reports the nearest site', () => {
    const result = checkGeofence({ lat: 19.1, lng: 72.9, accuracyM: 10 }, [office], 25);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('OUTSIDE_GEOFENCE');
      expect(result.nearest?.site.id).toBe('s1');
    }
  });

  it('reports low accuracy when inside but the fix is too vague', () => {
    const result = checkGeofence({ lat: 19.076, lng: 72.8777, accuracyM: 300 }, [office], 25);
    expect(result).toMatchObject({ ok: false, reason: 'LOW_ACCURACY' });
  });

  it('requires at least one site', () => {
    expect(checkGeofence({ lat: 0, lng: 0, accuracyM: 5 }, [], 25)).toEqual({ ok: false, reason: 'NO_SITES' });
  });
});
