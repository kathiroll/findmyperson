/**
 * Fails the Android build if the manifest it produced allows backup (plan 4.5).
 *
 *   node packages/encrypted-store/scripts/check-merged-manifest.ts <directory>
 *
 * <directory> is the app module's build/intermediates. Every merged manifest the Android
 * Gradle Plugin wrote under it is checked with checkFinalManifest. It is run by
 * build/build-android.sh after Gradle, so it sees what really ships: the app's manifest merged
 * with the manifest of every library, which is where a re-enabled backup would come from.
 *
 * Exits 0 only if at least one merged manifest was found and all of them pass. Finding none
 * is a failure, so a changed output path cannot turn this into a check that checks nothing.
 * Plain `node` runs this file as it is (Node 24 strips the types).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { checkFinalManifest, isMergedManifestPath } from '../src/backupPolicy.ts';

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const directory = process.argv[2];
if (directory === undefined) {
  console.error('usage: check-merged-manifest.ts <app module build/intermediates directory>');
  process.exit(64);
}

let manifests: string[];
try {
  manifests = filesUnder(directory).filter((path) =>
    isMergedManifestPath(relative(directory, path).split(sep).join('/')),
  );
} catch (error) {
  console.error(`backup check: cannot read ${directory}: ${(error as Error).message}`);
  process.exit(1);
}
if (manifests.length === 0) {
  console.error(
    `backup check: no merged AndroidManifest.xml under ${directory}; nothing was checked`,
  );
  process.exit(1);
}

let failed = false;
for (const manifest of manifests) {
  const violations = checkFinalManifest(readFileSync(manifest, 'utf8'));
  for (const violation of violations) {
    console.error(`backup check: ${manifest}: ${violation}`);
  }
  failed ||= violations.length > 0;
}
if (failed) {
  console.error(
    'backup check: FAILED. The built app would let Android back up or transfer its data. See packages/encrypted-store/README.md, "Backup exclusion".',
  );
  process.exit(1);
}
console.log(
  `backup check: ${manifests.length} merged manifest(s) forbid backup and device transfer`,
);
