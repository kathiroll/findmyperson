package com.storeproof

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.storeproof.store.CipherParams
import com.storeproof.store.KeystoreKeyProvider
import com.storeproof.store.NativeStoreWriter
import kotlin.concurrent.thread

/**
 * Debug-only, JS-free trigger for the device check:
 *   adb shell am broadcast -n com.storeproof/.WriteRowReceiver
 * Android starts the app process just to run this receiver, with no React instance, which is
 * the same situation as a background wake. Result is in `adb logcat -s FmpStoreProof`.
 */
class WriteRowReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        thread(name = "fmp-store-proof-write") {
            try {
                val path = context.getDatabasePath(CipherParams.DB_FILE_NAME).path
                val key = KeystoreKeyProvider(context).getOrCreateKeyHex()
                val ts = NativeStoreWriter.writeProbeRow(path, key, "broadcast-no-js")
                Log.i(TAG, "WROTE ts=$ts path=$path")
            } catch (e: Exception) {
                Log.e(TAG, "WRITE FAILED: ${e.message}", e)
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val TAG = "FmpStoreProof"
    }
}
