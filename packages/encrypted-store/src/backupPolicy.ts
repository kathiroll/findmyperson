/**
 * The Android backup rule, as a check that can be run on any AndroidManifest.xml (plan 4.5).
 *
 * Android backs app data up to the user's Google account by default, and copies it to a new
 * phone on device-to-device transfer. Either would take 30 days of location history off the
 * device. The rule: the <application> element of the app's merged manifest carries exactly
 * the three attributes below.
 *
 * It is enforced three times, because the way this regresses is a dependency's manifest
 * merging the default back in:
 *   - policy.test.ts runs these checks on every manifest in the repository, on every pull
 *     request;
 *   - scripts/check-merged-manifest.ts runs checkFinalManifest on the manifest the Android
 *     build actually produced, from build/build-android.sh, and fails the build;
 *   - StorePaths.requireBackupDisabled refuses to open the store on a phone whose installed
 *     app allows backup.
 *
 * This file uses no Node API and only erasable TypeScript, so the build script can run it
 * with plain `node`.
 */

/** What <application> must say. The two rule files are in android/src/main/res/xml. */
export const REQUIRED_APPLICATION_ATTRIBUTES: Readonly<Record<string, string>> = {
  'android:allowBackup': 'false',
  'android:dataExtractionRules': '@xml/fmp_store_data_extraction_rules',
  'android:fullBackupContent': '@xml/fmp_store_backup_rules',
};

/** Every backup domain Android defines. The rule files must exclude all of them. */
export const CLOUD_AND_TRANSFER_DOMAINS: readonly string[] = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
];
export const FULL_BACKUP_DOMAINS: readonly string[] = [
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
];

const withoutComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

/** The attributes of each `<tag ...>` in the document, in order. Quoted values may hold `>`. */
export function elementAttributes(xml: string, tag: string): Array<Record<string, string>> {
  const elements: Array<Record<string, string>> = [];
  const opening = new RegExp(`<${tag}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'g');
  for (const [, body = ''] of withoutComments(xml).matchAll(opening)) {
    const attributes: Record<string, string> = {};
    for (const [, name = '', double, single] of body.matchAll(
      /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attributes[name] = double ?? single ?? '';
    }
    elements.push(attributes);
  }
  return elements;
}

/**
 * A manifest that is the last word: the merged manifest of a build, the store library's own
 * manifest, or the app's main manifest. All three attributes must be present and exact.
 * Returns the violations, empty if there are none.
 */
export function checkFinalManifest(xml: string): string[] {
  const applications = elementAttributes(xml, 'application');
  if (applications.length !== 1) {
    return [`expected one <application> element, found ${applications.length}`];
  }
  const attributes = applications[0] ?? {};
  const violations = Object.entries(REQUIRED_APPLICATION_ATTRIBUTES).flatMap(([name, required]) =>
    attributes[name] === required
      ? []
      : [`${name} must be "${required}", found ${describe(attributes[name])}`],
  );
  return [...violations, ...removalViolations(attributes)];
}

/**
 * Any other manifest that takes part in a merge (a library, a debug or flavour overlay). It
 * need not mention backup at all, but it may not set one of the three attributes to another
 * value, and it may not remove one.
 */
export function checkContributingManifest(xml: string): string[] {
  return elementAttributes(xml, 'application').flatMap((attributes) => [
    ...Object.entries(REQUIRED_APPLICATION_ATTRIBUTES).flatMap(([name, required]) =>
      attributes[name] === undefined || attributes[name] === required
        ? []
        : [`${name} must be "${required}" or absent, found ${describe(attributes[name])}`],
    ),
    ...removalViolations(attributes),
  ]);
}

/** `tools:remove` of a required attribute, or `tools:node` dropping the element, undoes the rule. */
function removalViolations(attributes: Record<string, string>): string[] {
  const violations: string[] = [];
  const removed = (attributes['tools:remove'] ?? '').split(',').map((name) => name.trim());
  for (const name of Object.keys(REQUIRED_APPLICATION_ATTRIBUTES)) {
    if (removed.includes(name)) {
      violations.push(`tools:remove must not name ${name}`);
    }
  }
  const node = attributes['tools:node'];
  if (node !== undefined && node !== 'merge' && node !== 'strict') {
    violations.push(
      `tools:node="${node}" on <application> discards the store library's attributes`,
    );
  }
  return violations;
}

const describe = (value: string | undefined) => (value === undefined ? 'nothing' : `"${value}"`);

/**
 * A rule file must exclude every domain in every section and include nothing. `sections` is
 * ['cloud-backup', 'device-transfer'] for data extraction rules and ['full-backup-content']
 * for the older format.
 */
export function checkBackupRules(
  xml: string,
  sections: readonly string[],
  domains: readonly string[],
): string[] {
  const body = withoutComments(xml);
  if (/<include[\s/>]/.test(body)) {
    return ['a backup rule file must not <include> anything'];
  }
  return sections.flatMap((section) => {
    const match = new RegExp(`<${section}[^>]*>([\\s\\S]*?)</${section}>`).exec(body);
    if (match === null) {
      return [`missing <${section}> section`];
    }
    const excluded = elementAttributes(match[1] ?? '', 'exclude').map(
      (attributes) => attributes.domain,
    );
    return domains
      .filter((domain) => !excluded.includes(domain))
      .map((domain) => `<${section}> does not exclude domain "${domain}"`);
  });
}

/** Whether a path, with `/` separators, is a merged manifest that an Android build wrote. */
export function isMergedManifestPath(path: string): boolean {
  return /(^|\/)merged_manifests?\/.+\/AndroidManifest\.xml$/.test(path);
}
