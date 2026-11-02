#include "bindings/bindings.h"
#import <objc/runtime.h>
#import <UIKit/UIKit.h>

// The web view puts a form bar (‹ › Done) above the keyboard. Wandika draws its own writing
// toolbar there, so the web view's content view returns no accessory view.
static UIView *noAccessoryView(id self, SEL _cmd) {
	return nil;
}

static void hideFormAccessoryBar(void) {
	Class content = NSClassFromString(@"WKContentView");
	if (content) {
		class_replaceMethod(content, @selector(inputAccessoryView), (IMP)noAccessoryView, "@@:");
	}
}

int main(int argc, char * argv[]) {
	hideFormAccessoryBar();
	ffi::start_app();
	return 0;
}
