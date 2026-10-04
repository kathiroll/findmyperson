import { MAX_PERSON_PHOTOS } from '@findmyperson/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Field,
  InfoBanner,
  ScreenHeader,
  Text,
  colors,
  radii,
  sizes,
  spacing,
} from '../design-system';
import { useDataStore } from '../store';
import {
  addPhoto,
  buildRequest,
  canAddPhoto,
  emptyForm,
  PHOTO_LIMIT_ERROR,
  validateForm,
  type FormErrors,
  type ReportFormValues,
} from './form';
import { formatPoint, parseCoordinates } from './coordinates';
import { makeThumbnail } from './image';
import { useReportApi, useReportServices } from './services';

export const PRIVACY_BANNER =
  "You'll never see who has information, only messages people choose to send you. Your phone number is shown to people whose phones may have seen them, once your report is approved.";

export const REVIEW_NOTICE =
  'Your report is reviewed before anyone is notified. Nothing is broadcast until it is approved, and we may call the number you give us first.';

export const QUEUED_COPY =
  "Your report is saved on this phone but has not been sent yet. There's no connection to the service right now. We'll keep trying and send it as soon as we can. Keep this screen open or come back to the app later.";

export const PHOTO_HINT = `A recent, clear photo of their face helps most. You can add up to ${MAX_PERSON_PHOTOS}. Each is shrunk on this phone first.`;

export const REJECTED_COPY =
  'The service could not accept this report. Check the details below and try again.';

export type ReportSubmitScreenProps = {
  onBack: () => void;
  /** Called with the server's report id once the server holds the report (state `pending`). */
  onSubmitted: (reportId: string) => void;
  /** How often a queued report is retried while this screen is open. Default 15 s. */
  retryIntervalMs?: number;
  /** Unix seconds. Injectable for tests. */
  now?: () => number;
};

type Phase =
  | { kind: 'editing' }
  | { kind: 'sending' }
  /** Saved in the queue, waiting for the connection or the service. */
  | { kind: 'queued'; rowId: number }
  | { kind: 'rejected'; message: string };

const DEFAULT_RETRY_MS = 15_000;

export function ReportSubmitScreen({
  onBack,
  onSubmitted,
  retryIntervalMs = DEFAULT_RETRY_MS,
  now = () => Math.floor(Date.now() / 1000),
}: ReportSubmitScreenProps) {
  const insets = useSafeAreaInsets();
  const store = useDataStore();
  const api = useReportApi();
  const { photo: photoPort, location: locationPort } = useReportServices();

  const [values, setValues] = useState<ReportFormValues>(emptyForm);
  // Pasted coordinates, used only when the build has no map picker.
  const [coordText, setCoordText] = useState('');
  const typedPoint = parseCoordinates(coordText);
  const [errors, setErrors] = useState<FormErrors>({});
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const mounted = useRef(true);
  const passing = useRef(false);
  // One picker at a time, so two quick presses cannot both add a photo.
  const picking = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = <K extends keyof ReportFormValues>(key: K, value: ReportFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  // One pass over the queue; reacts to what happened to this screen's own row.
  const runQueue = useCallback(
    async (rowId: number) => {
      if (passing.current) return;
      passing.current = true;
      try {
        const result = await store.runReportQueue(api);
        if (!mounted.current) return;
        const sent = result.acknowledged.find((row) => row.id === rowId);
        if (sent !== undefined) {
          onSubmitted(sent.report.query_id);
          return;
        }
        const refused = result.failed.find((row) => row.id === rowId);
        if (refused !== undefined) {
          setPhase({ kind: 'rejected', message: `${REJECTED_COPY} (${refused.message})` });
          return;
        }
        setPhase({ kind: 'queued', rowId });
      } catch {
        // The store could not be used right now. The row is still queued (or never written).
        if (mounted.current) setPhase({ kind: 'queued', rowId });
      } finally {
        passing.current = false;
      }
    },
    [store, api, onSubmitted],
  );

  const queuedRow = phase.kind === 'queued' ? phase.rowId : null;
  useEffect(() => {
    if (queuedRow === null) return undefined;
    const timer = setInterval(() => void runQueue(queuedRow), retryIntervalMs);
    return () => clearInterval(timer);
  }, [queuedRow, retryIntervalMs, runQueue]);

  const pickPhoto = async () => {
    if (photoPort === null || picking.current) return;
    // A third photo is refused before the library opens, with the reason on screen.
    if (!canAddPhoto(values.photos)) {
      setPhotoError(PHOTO_LIMIT_ERROR);
      return;
    }
    setPhotoError(null);
    picking.current = true;
    try {
      const picked = await photoPort.pick();
      if (picked === null) return;
      const thumbnail = await makeThumbnail(photoPort, picked);
      if (!mounted.current) return;
      setValues((current) => {
        const added = addPhoto(current.photos, thumbnail);
        return added.ok ? { ...current, photos: added.photos } : current;
      });
    } catch {
      if (mounted.current) setPhotoError("That photo couldn't be used. Try another one.");
    } finally {
      picking.current = false;
    }
  };

  const removePhoto = (index: number) => {
    setPhotoError(null);
    setValues((current) => ({
      ...current,
      photos: current.photos.filter((_, i) => i !== index),
    }));
  };

  const pickLocation = async () => {
    if (locationPort === null) return;
    const picked = await locationPort.pick(values.location);
    if (picked !== null && mounted.current) set('location', picked);
  };

  const submit = async () => {
    // Pasted coordinates become the location before validation.
    let checked = values;
    if (locationPort === null) {
      checked = { ...values, location: typedPoint.ok ? typedPoint.point : null };
    }
    const found = validateForm(checked, now());
    if (locationPort === null && !typedPoint.ok && coordText.trim() !== '') {
      found.location = typedPoint.error;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setPhase({ kind: 'sending' });
    try {
      const row = await store.enqueueReport(buildRequest(checked, now()));
      await runQueue(row.id);
    } catch {
      if (mounted.current) {
        setPhase({
          kind: 'rejected',
          message: "We couldn't save your report on this phone. Please try again.",
        });
      }
    }
  };

  const locked = phase.kind === 'sending' || phase.kind === 'queued';
  const shownPhotoError = photoError ?? errors.photos ?? null;

  return (
    <View
      testID="screen-ReportForm"
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}
    >
      <ScreenHeader variant="back" title="Report a missing person" onBackPress={onBack} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[24],
          paddingBottom: spacing[24] + insets.bottom,
          gap: spacing[24],
        }}
      >
        <Text variant="title" accessibilityRole="header">
          Who is missing?
        </Text>

        <Field
          label="Their name"
          required
          placeholder="Full name"
          value={values.name}
          onChangeText={(text) => set('name', text)}
          editable={!locked}
          autoCapitalize="words"
          {...(errors.name ? { error: errors.name } : {})}
        />

        {photoPort === null ? null : (
          <View style={{ gap: spacing[8] }}>
            <Text variant="label">Photos</Text>
            {values.photos.map((thumbnail, index) => (
              <View
                // A list this short is keyed by position; removing one re-renders the rest.
                key={index}
                style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[12] }}
              >
                <Image
                  testID={`photo-thumbnail-${index}`}
                  accessibilityLabel={`Photo ${index + 1} of the missing person`}
                  source={{ uri: `data:${thumbnail.mime};base64,${thumbnail.b64}` }}
                  style={{ width: 96, height: 96, borderRadius: radii.photo }}
                />
                <Button
                  label="Remove photo"
                  accessibilityLabel={`Remove photo ${index + 1}`}
                  variant="ghost"
                  size="compact"
                  fullWidth={false}
                  disabled={locked}
                  onPress={() => removePhoto(index)}
                />
              </View>
            ))}
            {/* Stays pressable at the cap: pressing it then says why no more can be added. */}
            <Button
              label={values.photos.length === 0 ? 'Add photo' : 'Add another photo'}
              icon="plus"
              variant="ghost"
              fullWidth={false}
              disabled={locked}
              onPress={() => void pickPhoto()}
            />
            {shownPhotoError ? (
              <Text
                testID="photo-error"
                variant="caption"
                color="danger"
                accessibilityLiveRegion="polite"
              >
                {shownPhotoError}
              </Text>
            ) : (
              <Text variant="caption" color="muted">
                {PHOTO_HINT}
              </Text>
            )}
          </View>
        )}

        <Field
          label="Your phone number"
          required
          placeholder="+14155550123"
          hint="Include the country code."
          value={values.phone}
          onChangeText={(text) => set('phone', text)}
          editable={!locked}
          keyboardType="phone-pad"
          autoComplete="tel"
          {...(errors.phone ? { error: errors.phone } : {})}
        />

        <Text variant="heading" accessibilityRole="header">
          When and where were they last seen?
        </Text>

        {locationPort === null ? (
          <View style={{ gap: spacing[8] }}>
            <Field
              label="Last known location"
              required
              placeholder="28.6139, 77.2090"
              hint="In Google Maps, press and hold to drop a pin, then tap the coordinates to copy them and paste them here."
              value={coordText}
              onChangeText={setCoordText}
              editable={!locked}
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              {...(errors.location ? { error: errors.location } : {})}
            />
            {typedPoint.ok ? (
              <Text testID="accepted-location" variant="bodySmall" color="ink">
                {`Will be sent as ${formatPoint(typedPoint.point)}`}
              </Text>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: spacing[8] }}>
            <Text variant="label">Last known location</Text>
            <Card variant="outlined">
              <View style={{ gap: spacing[12] }}>
                <Text variant="body" color={values.location ? 'ink' : 'muted'}>
                  {values.location
                    ? `${values.location.lat.toFixed(5)}, ${values.location.lon.toFixed(5)}`
                    : 'No location set yet'}
                </Text>
                <Button
                  label="Set on map"
                  size="compact"
                  fullWidth={false}
                  disabled={locked}
                  onPress={() => void pickLocation()}
                />
              </View>
            </Card>
            {errors.location ? (
              <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
                {errors.location}
              </Text>
            ) : null}
          </View>
        )}

        <View style={{ flexDirection: 'row', gap: spacing[12] }}>
          <View style={{ flex: 1 }}>
            <Field
              label="Date"
              required
              placeholder="2026-09-18"
              value={values.date}
              onChangeText={(text) => set('date', text)}
              editable={!locked}
              keyboardType="numbers-and-punctuation"
              {...(errors.date ? { error: errors.date } : {})}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="Time"
              required
              placeholder="6:30 PM"
              value={values.time}
              onChangeText={(text) => set('time', text)}
              editable={!locked}
              {...(errors.time ? { error: errors.time } : {})}
            />
          </View>
        </View>

        <Field
          label="Details"
          rows={4}
          placeholder="What they were wearing, how they walk or talk, anything that helps someone recognise them."
          value={values.description}
          onChangeText={(text) => set('description', text)}
          editable={!locked}
          {...(errors.description ? { error: errors.description } : {})}
        />

        <InfoBanner testID="privacy-banner" message={PRIVACY_BANNER} />
        <InfoBanner testID="review-notice" icon="alert" message={REVIEW_NOTICE} />

        {phase.kind === 'queued' ? (
          <InfoBanner testID="queued-notice" icon="alert" message={QUEUED_COPY} />
        ) : null}
        {phase.kind === 'rejected' ? (
          <Text
            testID="submit-error"
            variant="bodySmall"
            color="danger"
            accessibilityLiveRegion="polite"
          >
            {phase.message}
          </Text>
        ) : null}

        <Button
          label={phase.kind === 'sending' ? 'Sending…' : 'Broadcast report'}
          accessibilityLabel="Broadcast report"
          trailingIcon="arrow"
          disabled={locked}
          onPress={() => void submit()}
        />
      </ScrollView>
    </View>
  );
}
