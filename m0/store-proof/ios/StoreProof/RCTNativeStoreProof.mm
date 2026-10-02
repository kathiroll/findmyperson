#import "RCTNativeStoreProof.h"
#import "StoreProof-Swift.h"

@implementation RCTNativeStoreProof

RCT_EXPORT_MODULE(NativeStoreProof)

- (void)getOrCreateKeyHex:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [StoreProofBridge getOrCreateKeyHex:^(NSString *_Nullable keyHex, NSString *_Nullable error) {
    if (keyHex != nil) {
      resolve(keyHex);
    } else {
      reject(@"KEY_FAILED", error, nil);
    }
  }];
}

- (void)writeProbeRow:(NSString *)dbPath
                label:(NSString *)label
         delaySeconds:(double)delaySeconds
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [StoreProofBridge writeProbeRow:dbPath
                            label:label
                     delaySeconds:delaySeconds
                       completion:^(NSNumber *_Nullable ts, NSString *_Nullable error) {
                         if (ts != nil) {
                           resolve(ts);
                         } else {
                           reject(@"WRITE_FAILED", error, nil);
                         }
                       }];
}

- (void)getDatabaseDirectory:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([StoreProofBridge databaseDirectory]);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeStoreProofSpecJSI>(params);
}

@end
