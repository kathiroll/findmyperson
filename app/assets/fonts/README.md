# Bundled fonts

Static instances cut from the Google Fonts variable masters (SIL OFL 1.1, licences alongside), because React Native on Android cannot select variable-font axes.

| File                                   | Source axes                 | Used for             |
| -------------------------------------- | --------------------------- | -------------------- |
| `BricolageGrotesque-Bold.ttf`          | wght 700, opsz 28, wdth 100 | display and headings |
| `AtkinsonHyperlegibleNext-Regular.ttf` | wght 400                    | body                 |
| `AtkinsonHyperlegibleNext-Bold.ttf`    | wght 700                    | labels, buttons      |

Family names in code are the PostScript names (file name without extension); see `src/design-system/fonts.ts`. They are linked into the native projects through `react-native.config.js` (`assets`) with `npx react-native-asset`, run in `app/`. That has been done for Android: the copies are in `android/app/src/main/assets/` (`fonts/` for the three files, `custom/` for the rest of this folder, licences included), recorded in `android/link-assets-manifest.json`. The iOS project references the three source files directly in its Resources phase and registers them in `Info.plist`; its archive check compares the bundled bytes to this directory. Run Android asset linking again after changing a file here, and keep the iOS resource references/registration current.
