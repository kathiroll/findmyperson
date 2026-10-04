// Metro configuration: the React Native template's, plus what a pnpm workspace needs.
import path from 'node:path';
import { getDefaultConfig, mergeConfig } from '@react-native/metro-config';

const appRoot = import.meta.dirname;
const workspaceRoot = path.resolve(appRoot, '..');

// Packages there must be exactly one copy of in the bundle. pnpm installs a package once per
// set of peer dependencies, so the workspace packages can see a different react-native directory
// than app/ does, and Metro would bundle both. These names always resolve as if app/ imported
// them, whoever does.
const singletons = ['react', 'react-native'];
const appEntry = path.join(appRoot, 'index.js');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  // The workspace packages and pnpm's store (node_modules/.pnpm) live above app/.
  watchFolders: [workspaceRoot],
  resolver: {
    // Where a module is looked for when the importing file's own node_modules does not have it:
    // the Babel runtime that compiled workspace sources import, which only app/ depends on.
    nodeModulesPaths: [path.resolve(appRoot, 'node_modules')],
    resolveRequest: (context, moduleName, platform) => {
      const pinned = singletons.some(
        (name) => moduleName === name || moduleName.startsWith(`${name}/`),
      );
      return context.resolveRequest(
        pinned ? { ...context, originModulePath: appEntry } : context,
        moduleName,
        platform,
      );
    },
  },
};

export default mergeConfig(getDefaultConfig(appRoot), config);
