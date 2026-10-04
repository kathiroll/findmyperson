import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useDataStore } from '../store';
import { API_BASE_URL, createReportApi, type ReportApi } from './api';
import type { PhotoPort } from './image';

/** Where the reporter sets the last-seen point on a map. Resolves null when they back out. */
export interface LocationPort {
  pick(initial: { lat: number; lon: number } | null): Promise<{ lat: number; lon: number } | null>;
}

/**
 * The native seams of the report form. `photo` and `location` need libraries (an image picker and
 * resizer, a map view) that are not in the app yet, so a build supplies them here. Without a
 * photo port the form hides "Add photo" (the photo is optional); without a location port it asks
 * for latitude and longitude as text, so a report can always be filed.
 */
export interface ReportServices {
  photo: PhotoPort | null;
  location: LocationPort | null;
  /** Override the backend client; production derives it from `API_BASE_URL`. */
  api?: ReportApi;
}

const ReportServicesContext = createContext<ReportServices>({ photo: null, location: null });

export function ReportServicesProvider({
  services,
  children,
}: {
  services: ReportServices;
  children: ReactNode;
}) {
  return (
    <ReportServicesContext.Provider value={services}>{children}</ReportServicesContext.Provider>
  );
}

export const useReportServices = () => useContext(ReportServicesContext);

/** The submit client: the override if a build gave one, else the real backend at API_BASE_URL. */
export function useReportApi(): ReportApi {
  const { api } = useReportServices();
  const store = useDataStore();
  return useMemo(
    () => api ?? createReportApi({ baseUrl: API_BASE_URL, identity: store.deviceIdentity }),
    [api, store],
  );
}
