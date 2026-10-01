package com.storeproof

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.storeproof.store.CipherParams
import com.storeproof.store.KeystoreKeyProvider
import com.storeproof.store.NativeStoreWriter
import java.util.concurrent.Executors

/** Turbo Native Module; the spec (NativeStoreProofSpec) is generated from src/specs/NativeStoreProof.ts. */
@ReactModule(name = StoreProofModule.NAME)
class StoreProofModule(private val reactContext: ReactApplicationContext) : NativeStoreProofSpec(reactContext) {
    // Off the JS and UI threads: opening a SQLCipher file and committing is blocking I/O.
    private val io = Executors.newSingleThreadExecutor()

    override fun getName() = NAME

    override fun getOrCreateKeyHex(promise: Promise) {
        io.execute {
            try {
                promise.resolve(KeystoreKeyProvider(reactContext).getOrCreateKeyHex())
            } catch (e: Exception) {
                promise.reject("KEY_FAILED", e.message, e)
            }
        }
    }

    override fun writeProbeRow(dbPath: String, label: String, delaySeconds: Double, promise: Promise) {
        io.execute {
            try {
                if (delaySeconds > 0) Thread.sleep((delaySeconds * 1000).toLong())
                val key = KeystoreKeyProvider(reactContext).getOrCreateKeyHex()
                promise.resolve(NativeStoreWriter.writeProbeRow(dbPath, key, label).toDouble())
            } catch (e: Exception) {
                promise.reject("WRITE_FAILED", e.message, e)
            }
        }
    }

    override fun getDatabaseDirectory(promise: Promise) {
        promise.resolve(reactContext.getDatabasePath(CipherParams.DB_FILE_NAME).parent)
    }

    companion object {
        const val NAME = "NativeStoreProof"
    }
}
