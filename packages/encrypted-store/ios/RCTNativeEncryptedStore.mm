#import "RCTNativeEncryptedStore.h"

#if __has_include("FindMyPersonEncryptedStore-Swift.h")
#import "FindMyPersonEncryptedStore-Swift.h"
#else
#import <FindMyPersonEncryptedStore/FindMyPersonEncryptedStore-Swift.h>
#endif

// Everything this module does is one call into EncryptedStore (Swift), through
// FMPEncryptedStoreBridge.
@implementation RCTNativeEncryptedStore

RCT_EXPORT_MODULE(NativeEncryptedStore)

- (void)getOrCreateStoreKeyHex:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPEncryptedStoreBridge getOrCreateStoreKeyHex:^(NSString *_Nullable keyHex, NSString *_Nullable code, NSString *_Nullable message) {
    if (keyHex != nil) {
      resolve(keyHex);
    } else {
      reject(code, message, nil);
    }
  }];
}

- (void)getStoreDirectory:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPEncryptedStoreBridge getStoreDirectory:^(NSString *_Nullable directory, NSString *_Nullable code, NSString *_Nullable message) {
    if (directory != nil) {
      resolve(directory);
    } else {
      reject(code, message, nil);
    }
  }];
}

- (void)deleteAllData:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [FMPEncryptedStoreBridge deleteAllData:^(NSNumber *_Nullable done, NSString *_Nullable code, NSString *_Nullable message) {
    if (done != nil) {
      resolve(nil);
    } else {
      reject(code, message, nil);
    }
  }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeEncryptedStoreSpecJSI>(params);
}

@end
