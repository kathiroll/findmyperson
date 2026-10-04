# Bundled fonts

Static instances cut from the Google Fonts variable masters (SIL OFL 1.1, licences alongside), because React Native on Android cannot select variable-font axes.

| File                                   | Source axes                 | Used for             |
| -------------------------------------- | --------------------------- | -------------------- |
| `BricolageGrotesque-Bold.ttf`          | wght 700, opsz 28, wdth 100 | display and headings |
| `AtkinsonHyperlegibleNext-Regular.ttf` | wght 400                    | body                 |
| `AtkinsonHyperlegibleNext-Bold.ttf`    | wght 700                    | labels, buttons      |

Family names in code are the PostScript names (file name without extension); see `src/design-system/fonts.ts`. They are linked into the native projects through `react-native.config.js` (`assets`) with `npx react-native-asset` once `app/android` and `app/ios` exist.
