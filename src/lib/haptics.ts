// Haptic feedback on phones, through Tauri's haptics plugin (iOS Taptic Engine and Android's
// vibrator). One kind per meaning, used sparingly: a selection tick when a gesture reaches its
// point, a light tap when a task is done, success when a focus round or the day's tasks finish.
// Outside the phone apps it does nothing.

import { native } from "./api";
import { isAndroid, isIOS } from "./platform";

export type Haptic = "selection" | "tap" | "success";

export function haptic(kind: Haptic) {
  if (!native || !(isIOS || isAndroid)) return;
  void import("@tauri-apps/plugin-haptics")
    .then((h) =>
      kind === "selection" ? h.selectionFeedback() : kind === "tap" ? h.impactFeedback("light") : h.notificationFeedback("success"),
    )
    .catch(() => {});
}
