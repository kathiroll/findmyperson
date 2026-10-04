// Font linking: `npx react-native-asset` copies these into the Android and iOS projects.
// An ES module, as every .js file of this package is ("type": "module" in package.json); the
// React Native CLI reads it on every Android build to list the modules to link.
export default {
  assets: ['./assets/fonts'],
};
