import Svg, { Circle, Path } from 'react-native-svg';
import type { TabParamList } from './routes';

/** 24x24 stroke glyphs for the three tabs, copied from the mockup's tab bar. */
export function TabIcon({
  route,
  color,
  size = 20,
}: {
  route: keyof TabParamList;
  color: string;
  size?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {route === 'Home' ? (
        <>
          <Path d="M3 11l9-8 9 8" />
          <Path d="M5 10v10h14V10" />
        </>
      ) : route === 'History' ? (
        <>
          <Circle cx={12} cy={12} r={9} />
          <Path d="M12 7v5l3 3" />
        </>
      ) : (
        <>
          <Circle cx={12} cy={12} r={3} />
          <Path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87" />
        </>
      )}
    </Svg>
  );
}
