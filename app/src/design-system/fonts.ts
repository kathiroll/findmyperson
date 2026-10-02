import { fontFamilies } from './theme';

/**
 * The fonts are bundled static TTFs in app/assets/fonts, linked into the native projects with
 * `npx react-native-asset` (see react-native.config.js). Native bundling means they are available
 * on first frame on both platforms, so there is no async loading step and no flash of fallback
 * text. Family names are the PostScript names, which iOS and Android both resolve.
 */
export const bundledFontFiles = [
  'BricolageGrotesque-Bold.ttf',
  'AtkinsonHyperlegibleNext-Regular.ttf',
  'AtkinsonHyperlegibleNext-Bold.ttf',
] as const;

export const fontFamilyNames = Object.values(fontFamilies);
