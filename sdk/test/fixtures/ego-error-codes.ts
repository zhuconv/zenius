// Portions adapted from citrolabs/ego-lite (MIT License).
//
// Ego Lite's error codes (ego-browser 0.1.0): those its SDK names, in
// package/ego-browser/src, and the native bindings' list in
// docs/native-bindings-api.md. errors.test.ts checks error-guide.ts's ego
// fields against it. Generated from refs/ego-lite by
// sdk/scripts/update-ego-codes.mjs; don't edit by hand.

export const EGO_ERROR_CODES: readonly string[] = [
  "EGO_BROWSER_UNAVAILABLE",
  "EGO_CDP_CHANNEL_UNAVAILABLE",
  "EGO_CDP_REQUEST_TIMEOUT",
  "EGO_CDP_SEND_FAILED",
  "EGO_CLIPBOARD_RESTORE_FAILED",
  "EGO_FILE_CHOOSER_OPENED",
  "EGO_FILE_CHOOSER_TIMEOUT",
  "EGO_INVALID_ARGUMENT",
  "EGO_INVALID_RESULT_PAYLOAD",
  "EGO_NAVIGATION_TIMEOUT",
  "EGO_OPERATION_FAILED",
  "EGO_PAGE_BUDGET_REACHED",
  "EGO_PAGE_DIALOG_OPENED",
  "EGO_PAGE_EVALUATION_TIMED_OUT",
  "EGO_PAGE_EXECUTION_DEADLINE",
  "EGO_PAGE_UNRESPONSIVE",
  "EGO_PROFILE_NOT_FOUND",
  "EGO_RESULT_CONVERSION_FAILED",
  "EGO_SNAPSHOT_FAILED",
  "EGO_TASK_HOST_DISCONNECTED",
  "EGO_TASK_SPACE_INACTIVE",
  "EGO_TASK_SPACE_NAME_IN_USE",
  "EGO_TASK_SPACE_NOT_FOUND",
  "EGO_TASK_SPACE_NOT_SELECTED",
  "EGO_TASK_SPACE_UNAVAILABLE",
  "EGO_TASK_SPACE_USER_IN_CONTROL",
  "EGO_URL_OPENED_IN_POPUP",
  "EGO_WEB_CONTENTS_UNAVAILABLE",
];
