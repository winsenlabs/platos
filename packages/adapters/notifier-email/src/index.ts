// The published surface of the email notifier.
//
// The adapter and its factory, plus the two renderers a suite asserts on so it
// does not keep a second copy of the message text. The SMTP session is NOT
// exported: nothing outside this package has a reason to speak SMTP.

export type { NotifierEmailAdapter, NotifierEmailOptions } from "./adapter.js";
export { MAGIC_LINK_SUBJECT, createNotifierEmailAdapter, magicLinkUrl, renderMagicLinkText } from "./adapter.js";
