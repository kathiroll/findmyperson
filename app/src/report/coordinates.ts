const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`;
const PAIR = new RegExp(`^(${NUMBER})\\s*°?\\s*(?:,\\s*|\\s+)(${NUMBER})\\s*°?$`);

export const COORDINATES_FORMAT_ERROR =
  'Enter latitude and longitude as two numbers, like 28.6139, 77.2090.';
export const LATITUDE_RANGE_ERROR = 'Latitude must be between -90 and 90.';
export const LONGITUDE_RANGE_ERROR = 'Longitude must be between -180 and 180.';

export type CoordinatesResult =
  { ok: true; point: { lat: number; lon: number } } | { ok: false; error: string };

/**
 * Reads "lat, lon" as Google Maps copies it. Tolerates surrounding whitespace, a comma or
 * whitespace separator and degree signs; refuses anything else, including hemisphere letters.
 */
export function parseCoordinates(input: string): CoordinatesResult {
  const match = PAIR.exec(input.trim());
  if (match === null) return { ok: false, error: COORDINATES_FORMAT_ERROR };
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: COORDINATES_FORMAT_ERROR };
  }
  if (Math.abs(lat) > 90) return { ok: false, error: LATITUDE_RANGE_ERROR };
  if (Math.abs(lon) > 180) return { ok: false, error: LONGITUDE_RANGE_ERROR };
  return { ok: true, point: { lat, lon } };
}

/** The accepted point as the reporter sees it, and as it is sent. */
export const formatPoint = (point: { lat: number; lon: number }): string =>
  `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
