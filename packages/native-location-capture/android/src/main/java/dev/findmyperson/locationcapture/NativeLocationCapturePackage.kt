package dev.findmyperson.locationcapture

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers the Turbo Module under the name the spec asks the registry for. Found by autolinking. */
class NativeLocationCapturePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeLocationCaptureSpec.NAME) NativeLocationCaptureModule(reactContext) else null

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            NativeLocationCaptureSpec.NAME to ReactModuleInfo(
                NativeLocationCaptureSpec.NAME,
                NativeLocationCaptureSpec.NAME,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                true, // isTurboModule
            ),
        )
    }
}
