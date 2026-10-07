#!/usr/bin/env bash
# Static proof only: never runs an emulator or claims runtime/device behaviour.
set -euo pipefail
archive="${1:?pass the xcarchive}"
link_map="${2:?pass the arm64 linker map}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 - "$archive" "$link_map" "$repo_root" <<'PYCODE'
import pathlib, plistlib, re, subprocess, sys
archive, link_map, repo = map(pathlib.Path, sys.argv[1:])
apps = list((archive / 'Products/Applications').glob('*.app'))
assert len(apps) == 1, 'archive must contain one app'
app = apps[0]
info = plistlib.loads((app / 'Info.plist').read_bytes())
binary = app / info['CFBundleExecutable']
assert info['CFBundleSupportedPlatforms'] == ['iPhoneOS'], 'must be a device app'
assert 'location' in info['UIBackgroundModes'], 'background location declaration missing'
for key in ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription']:
    assert info[key].strip(), f'{key} missing'
for font in (repo / 'app/assets/fonts').glob('*.ttf'):
    assert font.name in info['UIAppFonts'], f'{font.name} unregistered'
    assert (app / font.name).read_bytes() == font.read_bytes(), f'{font.name} missing/different'
bundle = (app / 'main.jsbundle').read_bytes()
assert bundle[:8] == bytes.fromhex('c61fbc03c103191f'), 'main.jsbundle must be Hermes bytecode'
assert subprocess.check_output(['xcrun', 'lipo', '-archs', str(binary)], text=True).strip() == 'arm64'
libraries = subprocess.check_output(['xcrun', 'otool', '-L', str(binary)], text=True)
assert 'libsqlite3' not in libraries, 'app directly links system SQLite'
assert '@rpath/hermesvm.framework/hermesvm' in libraries, 'Hermes framework missing'
assert (app / 'Frameworks/hermesvm.framework/hermesvm').is_file(), 'Hermes framework not embedded'
text = link_map.read_text()
objects = dict(re.findall(r'^\[\s*(\d+)\] (.+)$', text, re.M))
for symbol in ['_sqlite3_open_v2', '_sqlite3_key', '_sqlcipher_version']:
    owners = re.findall(r'^(?:0x[0-9A-Fa-f]+|<<dead>>)\s+0x[0-9A-Fa-f]+\s+\[\s*(\d+)\]\s+' + re.escape(symbol) + r'$', text, re.M)
    assert len(owners) == 1, f'{symbol} must have one definition'
    owner = objects[owners[0]]
    assert 'op-sqlite' in owner and 'sqlite3' in owner, f'{symbol} owned by {owner}'
for module in ['RCTNativeEncryptedStore', 'RCTNativeLocationCapture', 'RNGetRandomValues']:
    assert module in text, f'{module} missing from link output'
for file in ['EncryptedCaptureStore', 'EncryptedStore', 'FMPSqlcipher']:
    assert file in text, f'{file} missing from link output'
assert 'SQLiteCaptureStore.o' not in text, 'legacy capture opener included'
assert 'fmp_sqlite.o' not in text, 'legacy capture SQL front included'
print('ok: arm64 iOS archive, Hermes bundle, fonts, native modules and sole op-sqlite SQLCipher')
PYCODE
