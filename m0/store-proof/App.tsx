import { useCallback, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import NativeStoreProof from './src/specs/NativeStoreProof';
import { CIPHER_PARAMS } from './src/generated/cipherParams.generated';
import { openStore } from './src/store/openStore';
import { opSqliteDriver } from './src/store/opSqliteDriver';

/**
 * Plumbing proof, not a product screen. "Write natively" calls the Kotlin / Swift module, which
 * opens the same SQLCipher file itself; "Read in TypeScript" opens it through op-sqlite and lists
 * the rows. Typical device check: tap "Write in 20 s", background the app, lock the phone, wait,
 * unlock, reopen, tap "Read in TypeScript".
 */
export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const add = useCallback(
    (line: string) =>
      setLog(l => [`${new Date().toISOString().slice(11, 19)} ${line}`, ...l]),
    [],
  );

  const dbPath = useCallback(
    async () =>
      `${await NativeStoreProof.getDatabaseDirectory()}/${
        CIPHER_PARAMS.dbFileName
      }`,
    [],
  );

  const write = useCallback(
    async (delaySeconds: number) => {
      try {
        add(
          delaySeconds > 0
            ? `write requested, runs in ${delaySeconds}s`
            : 'write requested',
        );
        const ts = await NativeStoreProof.writeProbeRow(
          await dbPath(),
          `manual-${Date.now()}`,
          delaySeconds,
        );
        add(`native wrote ts=${ts}`);
      } catch (e) {
        add(`native write FAILED: ${(e as Error).message}`);
      }
    },
    [add, dbPath],
  );

  const read = useCallback(async () => {
    try {
      const store = await openStore({
        path: await dbPath(),
        keyHex: await NativeStoreProof.getOrCreateKeyHex(),
        driver: opSqliteDriver,
      });
      const rows = await store.readRows();
      await store.close();
      add(`TS read ${rows.length} row(s)`);
      rows.slice(-5).forEach(r => add(`  #${r.id} ts=${r.tsUtc} ${r.label}`));
    } catch (e) {
      add(`TS read FAILED: ${(e as Error).name}: ${(e as Error).message}`);
    }
  }, [add, dbPath]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <Text style={styles.title}>Store proof</Text>
        <Text style={styles.params}>
          SQLCipher {CIPHER_PARAMS.sqlcipherMajor}.x, page{' '}
          {CIPHER_PARAMS.pageSizeBytes}, kdf_iter {CIPHER_PARAMS.kdfIterations},{' '}
          {CIPHER_PARAMS.kdfAlgorithm}, {CIPHER_PARAMS.hmacAlgorithm}, raw key,{' '}
          {CIPHER_PARAMS.journalMode}
        </Text>
        <Button title="Write natively now" onPress={() => write(0)} />
        <Button title="Write natively in 20 s" onPress={() => write(20)} />
        <Button title="Read in TypeScript" onPress={read} />
        <ScrollView style={styles.log}>
          {log.map((l, i) => (
            <Text key={i} style={styles.line}>
              {l}
            </Text>
          ))}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: '600' },
  params: { fontSize: 12, color: '#555' },
  log: { flex: 1, marginTop: 8 },
  line: { fontFamily: 'Courier', fontSize: 12 },
});
