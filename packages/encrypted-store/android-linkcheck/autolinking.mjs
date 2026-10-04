// Prints the autolinking configuration of the link check, in the format React Native's Gradle
// plugin reads (what `npx @react-native-community/cli config` prints for an app). settings.gradle
// runs it. The three dependencies are the native modules that touch the store file.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const here = import.meta.dirname;
const storePackage = join(here, '..');
const require = createRequire(join(storePackage, 'package.json'));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

const roots = {
  '@op-engineering/op-sqlite': dirname(require.resolve('@op-engineering/op-sqlite/package.json')),
  '@findmyperson/encrypted-store': storePackage,
  '@findmyperson/native-location-capture': join(storePackage, '..', 'native-location-capture'),
};

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ['build', '.gradle', '.cxx', 'test'].includes(entry.name) ? [] : filesUnder(path);
    }
    return /\.(kt|java)$/.test(entry.name) ? [path] : [];
  });
}

// The class that registers the module with React Native, found as the community CLI finds it.
function reactPackage(sourceDir) {
  for (const file of filesUnder(join(sourceDir, 'src'))) {
    const source = readFileSync(file, 'utf8');
    const name =
      /class\s+(\w+)\s*(?:\([^)]*\)\s*)?(?::|extends|implements)[^{]*\b(?:ReactPackage|BaseReactPackage|TurboReactPackage)\b/.exec(
        source,
      )?.[1];
    const javaPackage = /^package\s+([\w.]+)/m.exec(source)?.[1];
    if (name !== undefined && javaPackage !== undefined) {
      return { name, javaPackage };
    }
  }
  throw new Error(`no ReactPackage class under ${sourceDir}`);
}

const dependencies = Object.fromEntries(
  Object.entries(roots).map(([name, root]) => {
    const sourceDir = join(root, 'android');
    const { name: className, javaPackage } = reactPackage(sourceDir);
    const libraryName = json(join(root, 'package.json')).codegenConfig?.name ?? null;
    return [
      name,
      {
        root,
        name,
        platforms: {
          android: {
            sourceDir,
            packageImportPath: `import ${javaPackage}.${className};`,
            packageInstance: `new ${className}()`,
            buildTypes: [],
            libraryName,
            componentDescriptors: [],
            cmakeListsPath:
              libraryName === null
                ? null
                : join(sourceDir, 'build/generated/source/codegen/jni/CMakeLists.txt'),
          },
        },
      },
    ];
  }),
);

const reactNativeVersion = json(require.resolve('react-native/package.json')).version;
console.log(
  JSON.stringify(
    {
      root: here,
      reactNativePath: dirname(require.resolve('react-native/package.json')),
      reactNativeVersion: reactNativeVersion.split('.').slice(0, 2).join('.'),
      dependencies,
      project: {
        android: {
          sourceDir: join(here, 'android'),
          appName: 'app',
          packageName: 'dev.findmyperson.linkcheck',
          applicationId: 'dev.findmyperson.linkcheck',
          mainActivity: '.MainActivity',
          watchModeCommandParams: null,
          dependencyConfiguration: null,
        },
      },
    },
    null,
    2,
  ),
);
