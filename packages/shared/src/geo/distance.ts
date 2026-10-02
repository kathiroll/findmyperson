/** A WGS84 position in decimal degrees. The same shape is used on the wire and in the store. */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Mean Earth radius in metres (IUGG). Kotlin and Swift must use this exact number. It is not
 * the radius H3's own greatCircleDistance uses (6371007.18 m), so do not substitute that
 * function for haversineMeters.
 */
export const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres between two points, by the haversine formula on a sphere of
 * radius EARTH_RADIUS_M. This is the only distance function in the project: stay derivation,
 * matching and the widen-only rule all call it.
 *
 * Native code must reproduce the same sequence of operations. contracts/geo-vectors.json holds
 * the expected values; libm differences between platforms stay far inside its tolerance.
 */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const phi1 = toRadians(a.lat);
  const phi2 = toRadians(b.lat);
  const sinHalfDPhi = Math.sin((phi2 - phi1) / 2);
  const sinHalfDLambda = Math.sin(toRadians(b.lon - a.lon) / 2);
  const h =
    sinHalfDPhi * sinHalfDPhi + Math.cos(phi1) * Math.cos(phi2) * sinHalfDLambda * sinHalfDLambda;
  // Rounding can push h a hair above 1 for antipodal points; clamp so asin stays defined.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** True when the value is a finite latitude and longitude inside the valid ranges. */
export function isValidLatLon(p: LatLon): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180
  );
}
