import {
  E164_PATTERN,
  MAX_PERSON_DESCRIPTION_CHARS,
  MAX_PERSON_NAME_CHARS,
  MAX_SEARCH_RADIUS_M,
  RETENTION_SEC,
  ReportSubmitRequestSchema,
  type PersonPhoto,
  type ReportSubmitRequest,
} from '@findmyperson/shared';

/**
 * PROVISIONAL criteria the form does not ask for. The mockup has no radius or window control, but
 * the contract needs both. The window is centred on the last-seen time; matching rounds it
 * outward anyway (packages/shared/src/match).
 */
export const DEFAULT_SEARCH_RADIUS_M = 500;
export const WINDOW_BEFORE_SEC = 30 * 60;
export const WINDOW_AFTER_SEC = 30 * 60;

export interface ReportFormValues {
  name: string;
  phone: string;
  /** "YYYY-MM-DD", the reporter's local date. */
  date: string;
  /** "H:MM" or "HH:MM", 24 hour, or "H:MM AM/PM". Local time. */
  time: string;
  description: string;
  location: { lat: number; lon: number } | null;
  photo: PersonPhoto | null;
}

export const emptyForm: ReportFormValues = {
  name: '',
  phone: '',
  date: '',
  time: '',
  description: '',
  location: null,
  photo: null,
};

export type FieldName = 'name' | 'phone' | 'location' | 'date' | 'time' | 'description';
export type FormErrors = Partial<Record<FieldName, string>>;

/** "+1 (415) 555-0123" becomes "+14155550123". Anything else is left for the pattern to refuse. */
export function normalizePhone(input: string): string {
  return input.trim().replace(/[\s().-]/g, '');
}

/** Local date and time to a Date, or null if either does not read as a real moment. */
export function parseLocalDateTime(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/.exec(time.trim());
  if (d === null || t === null) return null;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  let hour = Number(t[1]);
  const minute = Number(t[2]);
  const meridiem = t[3]?.toLowerCase();
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  if (minute > 59) return null;
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  // new Date rolls 31 Feb over to March; a real date comes back unchanged.
  return parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
    ? parsed
    : null;
}

export const PHONE_ERROR = 'Enter a phone number with country code, like +14155550123.';

/** Every field, checked together, so the reporter sees all the problems at once. */
export function validateForm(values: ReportFormValues, nowSec: number): FormErrors {
  const errors: FormErrors = {};
  const name = values.name.trim();
  if (name === '') errors.name = 'Enter their name.';
  else if (name.length > MAX_PERSON_NAME_CHARS) {
    errors.name = `Keep the name under ${MAX_PERSON_NAME_CHARS} characters.`;
  }

  if (values.phone.trim() === '') {
    errors.phone = 'Your phone number is required. It is how we reach you.';
  } else if (!E164_PATTERN.test(normalizePhone(values.phone))) {
    errors.phone = PHONE_ERROR;
  }

  if (values.location === null) {
    errors.location = 'Set where they were last seen.';
  } else if (!(Math.abs(values.location.lat) <= 90 && Math.abs(values.location.lon) <= 180)) {
    errors.location = 'That location is not on the map.';
  }

  const when = parseLocalDateTime(values.date, values.time);
  if (values.date.trim() === '') errors.date = 'Enter the date, like 2026-09-18.';
  else if (parseLocalDateTime(values.date, '0:00') === null) {
    errors.date = 'Use the form 2026-09-18.';
  }
  if (values.time.trim() === '') errors.time = 'Enter the time, like 18:30 or 6:30 PM.';
  else if (parseLocalDateTime('2000-01-01', values.time) === null) {
    errors.time = 'Use the form 18:30 or 6:30 PM.';
  }
  if (when !== null) {
    const at = Math.floor(when.getTime() / 1000);
    if (at > nowSec) errors.time = 'They cannot have been seen in the future.';
    else if (nowSec - at > RETENTION_SEC - WINDOW_AFTER_SEC) {
      errors.date = 'Reports can cover the last 30 days at most.';
    }
  }

  if (values.description.length > MAX_PERSON_DESCRIPTION_CHARS) {
    errors.description = `Keep the details under ${MAX_PERSON_DESCRIPTION_CHARS} characters.`;
  }
  return errors;
}

/**
 * The submit body for a form that passed `validateForm`. Throws if it did not, or if the result
 * is not a valid `ReportSubmitRequest`, so a bad request is never queued.
 */
export function buildRequest(values: ReportFormValues, nowSec: number): ReportSubmitRequest {
  const errors = validateForm(values, nowSec);
  const when = parseLocalDateTime(values.date, values.time);
  if (Object.keys(errors).length > 0 || when === null || values.location === null) {
    throw new RangeError('the form is not valid');
  }
  const at = Math.floor(when.getTime() / 1000);
  return ReportSubmitRequestSchema.parse({
    center: { lat: values.location.lat, lon: values.location.lon },
    radius_m: Math.min(DEFAULT_SEARCH_RADIUS_M, MAX_SEARCH_RADIUS_M),
    window: { from: at - WINDOW_BEFORE_SEC, to: Math.min(at + WINDOW_AFTER_SEC, nowSec) },
    person: {
      name: values.name.trim(),
      description: values.description.trim(),
      ...(values.photo === null ? {} : { photo: values.photo }),
    },
    reporter_phone: normalizePhone(values.phone),
  });
}
