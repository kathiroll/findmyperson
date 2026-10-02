import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const stub = (name: string) =>
  fileURLToPath(new URL(`./src/design-system/__tests__/stubs/${name}`, import.meta.url));

// react-native ships Flow-typed sources that vitest cannot parse, so component tests render the
// design system against light host-component stubs (src/design-system/__tests__/stubs).
export default defineConfig({
  resolve: {
    alias: {
      'react-native-svg': stub('react-native-svg.tsx'),
      'react-native': stub('react-native.tsx'),
    },
  },
  test: { name: 'app' },
});
