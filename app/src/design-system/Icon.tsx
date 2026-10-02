import Svg, { Circle, Path } from 'react-native-svg';
import { colors, type ColorName } from './theme';

type Shape =
  | { kind: 'path'; d: string; fill?: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: boolean };

const path = (d: string): Shape => ({ kind: 'path', d });
const circle = (cx: number, cy: number, r: number, fill = false): Shape => ({
  kind: 'circle',
  cx,
  cy,
  r,
  fill,
});

/** 24x24 stroke glyphs copied from the mockups' inline SVG. */
const glyphs = {
  logo: [circle(12, 12, 10), circle(12, 12, 5), circle(12, 12, 1.5, true)],
  menu: [path('M4 7h16M4 12h16M4 17h16')],
  close: [path('M18 6L6 18M6 6l12 12')],
  back: [path('M15 18l-6-6 6-6')],
  arrow: [path('M5 12h14M13 6l6 6-6 6')],
  external: [path('M7 17L17 7M9 7h8v8')],
  info: [circle(12, 12, 9), path('M12 8v5M12 16h.01')],
  alert: [path('M12 4l9 16H3z'), path('M12 10v4M12 17h.01')],
  dots: [circle(5, 12, 1.8, true), circle(12, 12, 1.8, true), circle(19, 12, 1.8, true)],
  phone: [
    path(
      'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z',
    ),
  ],
  message: [path('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  person: [circle(12, 9, 3.5), path('M5 20c1-4 4-5.5 7-5.5s6 1.5 7 5.5')],
  plus: [path('M12 5v14M5 12h14')],
  minusCircle: [circle(12, 12, 9), path('M8 12h8')],
  eye: [path('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'), circle(12, 12, 3)],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof glyphs;
export const iconNames = Object.keys(glyphs) as IconName[];

export type IconProps = {
  name: IconName;
  size?: number;
  color?: ColorName;
  strokeWidth?: number;
};

/** Decorative by default: the parent control carries the accessible label. */
export function Icon({ name, size = 24, color = 'ink', strokeWidth = 2 }: IconProps) {
  const tint = colors[color];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={tint}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {glyphs[name].map((shape, index) => {
        const paint = shape.fill ? { fill: tint, stroke: 'none' } : {};
        return shape.kind === 'path' ? (
          <Path key={index} d={shape.d} {...paint} />
        ) : (
          <Circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} {...paint} />
        );
      })}
    </Svg>
  );
}
