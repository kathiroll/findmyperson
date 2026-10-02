/**
 * Design tokens, extracted from the v2 mockups (Design canvas "findmyperson mockups").
 * Where the mockups disagree with the v1 notes in design-system.md, the mockups win: typefaces
 * are Bricolage Grotesque + Atkinson Hyperlegible Next (not Plus Jakarta Sans), placeholder text is
 * #5A6A88 (not #8C9AB8) and input borders are #7F8EAD (not #D9E2F5) for contrast, and the bottom
 * tab bar is gone (navigation is the hamburger menu).
 */

export const colors = {
  primary: '#2B5EFF',
  primaryPressed: '#1E46CC',
  primaryDeep: '#16359C',
  ink: '#0F1A2B',
  muted: '#4C5C7A',
  placeholder: '#5A6A88',
  background: '#F2F5FC',
  surface: '#FFFFFF',
  border: '#D9E2F5',
  borderStrong: '#7F8EAD',
  borderMap: '#C3D1F5',
  progressOff: '#C9D6F5',
  tint: '#E4ECFF',
  tintPressed: '#D3DFFF',
  focusRing: '#C9D8FF',
  success: '#1F9E6D',
  danger: '#B23B3B',
  dangerPressed: '#962F2F',
  warningBorder: '#D9A441',
  warningText: '#8A4B00',
  disabledSurface: '#E3E8F3',
  disabledText: '#4C5C7A',
  white: '#FFFFFF',
  scrim: 'rgba(15, 26, 43, 0.6)',
  onBlueDivider: 'rgba(255, 255, 255, 0.45)',
  shadow: 'rgba(15, 26, 43, 0.16)',
} as const;

export type ColorName = keyof typeof colors;

/** Keys are the pixel values the mockups use. */
export const spacing = {
  2: 2,
  4: 4,
  6: 6,
  8: 8,
  10: 10,
  12: 12,
  14: 14,
  16: 16,
  18: 18,
  20: 20,
  24: 24,
  28: 28,
  32: 32,
  36: 36,
  40: 40,
} as const;

export const radii = {
  progress: 2,
  menuItem: 12,
  field: 14,
  banner: 16,
  iconChip: 16,
  iconButton: 16,
  option: 16,
  popover: 16,
  photo: 18,
  statusPill: 18,
  listCard: 20,
  card: 24,
  sheet: 28,
  /** Buttons are fully pill-shaped: use `pill(height)`. */
  pill: 999,
} as const;

export const pill = (height: number): number => height / 2;

/** Touch-target sizes (px). Nothing interactive is smaller than `minTarget`. */
export const sizes = {
  minTarget: 44,
  iconButton: 48,
  buttonLarge: 56,
  buttonMedium: 52,
  buttonCompact: 48,
  buttonSmall: 44,
  field: 52,
  option: 52,
  listRow: 56,
  menuRow: 76,
  menuRowFirst: 88,
  /** Screen gutter used by every mockup. */
  gutter: 24,
} as const;

export const fontFamilies = {
  /** Bricolage Grotesque Bold: display and headings. */
  display: 'BricolageGrotesque-Bold',
  /** Atkinson Hyperlegible Next Regular: body copy. */
  body: 'AtkinsonHyperlegibleNext-Regular',
  /** Atkinson Hyperlegible Next Bold: labels, buttons, emphasis. */
  bodyBold: 'AtkinsonHyperlegibleNext-Bold',
} as const;

const em = (size: number, value: number): number => Math.round(size * value * 100) / 100;

type TypeStyle = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
};

const display = (size: number, lineHeight: number, tracking: number): TypeStyle => ({
  fontFamily: fontFamilies.display,
  fontSize: size,
  lineHeight: em(size, lineHeight),
  letterSpacing: em(size, tracking),
});

const body = (size: number, lineHeight: number, bold = false, tracking = 0): TypeStyle => ({
  fontFamily: bold ? fontFamilies.bodyBold : fontFamilies.body,
  fontSize: size,
  lineHeight: em(size, lineHeight),
  ...(tracking === 0 ? {} : { letterSpacing: em(size, tracking) }),
});

export const typography = {
  display: display(42, 1.02, -0.03),
  menuItem: display(28, 1.08, -0.025),
  title: display(30, 1.08, -0.025),
  heading: display(24, 1.12, -0.02),
  brand: display(19, 1.25, -0.02),
  bodyLarge: body(17, 1.45),
  body: body(15, 1.5),
  bodySmall: body(14, 1.5),
  caption: body(13, 1.45),
  itemTitle: body(15, 1.4, true),
  label: body(14, 1.4, true),
  eyebrow: body(13, 1.4, true, 0.02),
  button: body(16, 1.25, true),
  buttonSmall: body(15, 1.25, true),
  /** Text inside inputs: 16px stops iOS zooming; no lineHeight so TextInput stays vertically centred. */
  input: { fontFamily: fontFamilies.body, fontSize: 16 } satisfies Omit<TypeStyle, 'lineHeight'>,
} as const;

export type TypographyVariant = keyof typeof typography;

/** Shared easing curve and durations from the mockups' CSS animations. */
export const motion = {
  /** cubic-bezier(.2,.7,.2,1) */
  easing: [0.2, 0.7, 0.2, 1] as const,
  duration: {
    pop: 220,
    fade: 300,
    press: 250,
    rise: 700,
    grow: 800,
    sheet: 550,
    pulse: 2400,
    ring: 9000,
  },
  /** CSS keyframe: 0-70% expands, 70-100% rests. */
  pulse: { scale: 3.4, startOpacity: 0.5, activeShare: 0.7 },
  riseDistance: 14,
  pressScale: 0.98,
} as const;

export const elevation = {
  popover: {
    shadowColor: colors.ink,
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
} as const;

export const theme = { colors, spacing, radii, sizes, fontFamilies, typography, motion, elevation };

export type Theme = typeof theme;
