/**
 * The real module, as `@findmyperson/native-location-capture/native`.
 *
 * It is a separate entry because importing it loads react-native and looks the module up in the
 * registry at once, which throws anywhere the native code is not linked in: Node, unit tests, an
 * app built before the Android and iOS modules exist. Code that only needs the interface, the
 * constants or the fake imports the package root or `/fake` and never reaches this file.
 */
export { default as NativeLocationCapture } from './specs/NativeLocationCapture';
