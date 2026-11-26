// The device backstop's fallback (the core): in each content process, a
// task page's device request is denied as MediaManager makes it, while the
// agent drives the page or when the page shows evidence of danger, the
// parent's rule (the observe layer's glue). The parent
// registers this process actor only when its WebRTCParent patch can't go in
// (modules/backstops.sys.mjs), and only while a task has pages (I4).
//
// MediaManager announces each getUserMedia, getDisplayMedia and
// selectAudioOutput request on "getUserMedia:request" and takes the
// front end's answer on "getUserMedia:response:deny", the contract
// WebRTCChild uses. Denied here, the request settles with NotAllowedError
// and no device starts, whatever the parent does with the copy WebRTCChild
// still sends it (docs/SPI.md, "Parent backstops").

import { AGENT_BROWSERS_KEY, TASK_BROWSERS_KEY } from "chrome://userscripts/content/zenius/content/taskset.sys.mjs";
import { isEvident } from "chrome://userscripts/content/zenius/content/evidence.sys.mjs";

export class ZeniusDeviceBackstopChild extends JSProcessActorChild {
  observe(subject, topic) {
    if (topic !== "getUserMedia:request") {
      return;
    }
    let callID = "";
    let refuse = true;
    try {
      callID = subject.callID;
      const win = Services.wm.getOuterWindowWithId(subject.windowID);
      const id = win?.browsingContext?.top?.browserId;
      // A window it can't place is refused, as an error is.
      const shared = Services.cpmm.sharedData;
      refuse = !id || !!shared.get(AGENT_BROWSERS_KEY)?.has(id) || (!!shared.get(TASK_BROWSERS_KEY)?.has(id) && isEvident(win.browsingContext));
    } catch (e) {
      console.error("[zenius] the device backstop's check failed, so the request is refused", e);
    }
    if (refuse && callID) {
      Services.obs.notifyObservers(null, "getUserMedia:response:deny", callID);
    }
  }
}
