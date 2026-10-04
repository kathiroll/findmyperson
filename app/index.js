// What React Native runs first: Metro bundles from this file, and the native projects start the
// component registered here by name (`getMainComponentName` in MainActivity.kt). It registers
// the navigator and nothing else.
import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';
import { AppNavigator } from './src/navigation';

AppRegistry.registerComponent(appName, () => AppNavigator);
