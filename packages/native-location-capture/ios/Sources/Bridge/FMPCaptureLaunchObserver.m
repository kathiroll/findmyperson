#import <UIKit/UIKit.h>

#if __has_include("FMPLocationCapture-Swift.h")
#import "FMPLocationCapture-Swift.h"
#else
#import <FMPLocationCapture/FMPLocationCapture-Swift.h>
#endif

// Restarts capture on every launch without the app having to remember to.
//
// When iOS relaunches a dead app for a location event, the launch code is all that runs: the
// user did not open anything and JavaScript may never ask for the module. iOS does not restart
// continuous updates by itself, and the event that caused the relaunch is delivered only to a
// location manager that exists by then. So the module hooks the launch itself. The notification
// is posted on the main thread as application:didFinishLaunchingWithOptions: returns, and its
// userInfo is the launch options.
//
// An app may also call +[FMPCaptureBridge resumeWithLaunchOptions:] from its app delegate.
// Whichever comes first acts; the other does nothing.
@interface FMPCaptureLaunchObserver : NSObject
@end

@implementation FMPCaptureLaunchObserver

+ (void)load
{
  // Never removed: it has to outlive everything, and it fires once.
  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                [FMPCaptureBridge resumeWithLaunchOptions:note.userInfo];
              }];
}

@end
