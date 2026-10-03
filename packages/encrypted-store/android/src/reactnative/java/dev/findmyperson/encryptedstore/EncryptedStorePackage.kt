package dev.findmyperson.encryptedstore

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers [EncryptedStoreModule]. React Native's autolinking finds this class by itself. */
class EncryptedStorePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == EncryptedStoreModule.NAME) EncryptedStoreModule(reactContext) else null

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            EncryptedStoreModule.NAME to ReactModuleInfo(
                name = EncryptedStoreModule.NAME,
                className = EncryptedStoreModule.NAME,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            ),
        )
    }
}
