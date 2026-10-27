export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface GeofenceSite extends GeoPoint {
  readonly id: string;
  readonly name: string;
  readonly radiusM: number;
  readonly maxAccuracyM: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type GeofenceOutcome =
  | { readonly ok: true; readonly site: GeofenceSite; readonly distanceM: number }
  | { readonly ok: false; readonly reason: 'NO_SITES' | 'LOW_ACCURACY' | 'OUTSIDE_GEOFENCE'; readonly nearest?: { readonly site: GeofenceSite; readonly distanceM: number } };

export interface GeofenceFix extends GeoPoint {
  readonly accuracyM: number;
}

/**
 * Inside if, for some allowed site, distance ≤ radius + min(accuracy, bufferCap) and the fix
 * accuracy is within that site's maximum. The nearest site is reported for UX on failure.
 */
export function checkGeofence(fix: GeofenceFix, sites: readonly GeofenceSite[], accuracyBufferCapM: number): GeofenceOutcome {
  if (sites.length === 0) {
    return { ok: false, reason: 'NO_SITES' };
  }
  const ranked = sites
    .map((site) => ({ site, distanceM: haversineMeters(fix, site) }))
    .sort((a, b) => a.distanceM - b.distanceM);
  const buffer = Math.min(fix.accuracyM, accuracyBufferCapM);
  const inside = ranked.find(({ site, distanceM }) => fix.accuracyM <= site.maxAccuracyM && distanceM <= site.radiusM + buffer);
  if (inside) {
    return { ok: true, site: inside.site, distanceM: Math.round(inside.distanceM) };
  }
  const nearest = ranked[0];
  const geometricallyInside = ranked.some(({ site, distanceM }) => distanceM <= site.radiusM + buffer);
  const nearestRounded = { site: nearest.site, distanceM: Math.round(nearest.distanceM) };
  return geometricallyInside
    ? { ok: false, reason: 'LOW_ACCURACY', nearest: nearestRounded }
    : { ok: false, reason: 'OUTSIDE_GEOFENCE', nearest: nearestRounded };
}
