#import "RCTNativeLocationCapture.h"

#import <React/RCTUtils.h>

#if __has_include("FMPLocationCapture-Swift.h")
#import "FMPLocationCapture-Swift.h"
#else
#import <FMPLocationCapture/FMPLocationCapture-Swift.h>
#endif

// A shim and nothing more: every method hands its arguments to FMPCaptureBridge (Swift), where
// the behaviour lives and is tested. Keep it that way; this file is not covered by `swift test`.

@interface RCTNativeLocationCapture () <FMPCaptureEventSink>
@end

// A rejected promise carries one of CAPTURE_ERROR_CODES as its `code`.
static void (^Rejecter(RCTPromiseRejectBlock reject))(NSString *, NSString *)
{
  return ^(NSString *code, NSString *message) {
    reject(code, message, nil);
  };
}

@implementation RCTNativeLocationCapture

RCT_EXPORT_MODULE(NativeLocationCapture)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

// Core Location calls back on the main thread and the engine is confined to it, so the spec's
// methods run there too. Each one is short.
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (instancetype)init
{
  if ((self = [super init])) {
    __weak __typeof(self) weakSelf = self;
    RCTExecuteOnMainQueue(^{
      __typeof(self) strongSelf = weakSelf;
      if (strongSelf != nil) {
        [FMPCaptureBridge.shared addSink:strongSelf];
      }
    });
  }
  return self;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeLocationCaptureSpecJSI>(params);
}

#pragma mark - Events

// Capture runs before JavaScript exists (a background relaunch), and the generated emit
// methods call the callback without checking that React Native has set it.

- (void)captureSampleWritten:(NSDictionary<NSString *, id> *)event
{
  if (_eventEmitterCallback) {
    [self emitOnSampleWritten:event];
  }
}

- (void)captureStatusChanged:(NSDictionary<NSString *, id> *)status
{
  if (_eventEmitterCallback) {
    [self emitOnStatusChanged:status];
  }
}

#pragma mark - Spec

- (void)getOrCreateStoreKeyHex:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared getOrCreateStoreKeyHexWithResolve:resolve reject:Rejecter(reject)];
}

- (void)getStoreDirectory:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared getStoreDirectoryWithResolve:resolve reject:Rejecter(reject)];
}

- (void)initStore:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared initStoreWithResolve:resolve reject:Rejecter(reject)];
}

- (void)start:(JS::NativeLocationCapture::CaptureConfig &)config
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  // useForegroundService and the notification text are Android's; iOS ignores them.
  [FMPCaptureBridge.shared startWithMinIntervalSec:config.minIntervalSec()
                                      minDistanceM:config.minDistanceM()
                                          accuracy:config.accuracy() ?: @""
                                           resolve:resolve
                                            reject:Rejecter(reject)];
}

- (void)stop:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared stopWithResolve:resolve reject:Rejecter(reject)];
}

- (void)getStatus:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared getStatusWithResolve:resolve reject:Rejecter(reject)];
}

- (void)requestPermission:(NSString *)step
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared requestPermissionWithStep:step ?: @""
                                             resolve:resolve
                                              reject:Rejecter(reject)];
}

- (void)openSystemSettings:(NSString *)target
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared openSystemSettingsWithTarget:target ?: @""
                                                resolve:resolve
                                                 reject:Rejecter(reject)];
}

- (void)getDiagnostics:(double)sinceTsUtc
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared getDiagnosticsSinceTsUtc:sinceTsUtc
                                            resolve:resolve
                                             reject:Rejecter(reject)];
}

- (void)getDeviceConditions:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared getDeviceConditionsWithResolve:resolve reject:Rejecter(reject)];
}

- (void)getNetworkConditions:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared getNetworkConditionsWithResolve:resolve reject:Rejecter(reject)];
}

- (void)debugInjectSample:(double)lat
                      lon:(double)lon
                    tsUtc:(double)tsUtc
                accuracyM:(double)accuracyM
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [FMPCaptureBridge.shared debugInjectSampleWithLat:lat
                                                lon:lon
                                              tsUtc:tsUtc
                                          accuracyM:accuracyM
                                            resolve:resolve
                                             reject:Rejecter(reject)];
}

@end
