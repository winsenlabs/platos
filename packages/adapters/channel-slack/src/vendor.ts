// THE ONE FILE IN THE REPOSITORY THAT NAMES THE CHAT SDK.
//
// ADR M0.3 §5.1(h) pins each vendor client to one adapter directory, and
// `scripts/arch/boundary-rules.mjs` rule `chat-sdk-only` makes that mechanical:
// any file outside `packages/adapters/channel-slack/` importing `chat` or
// `@chat-adapter/*` fails the boundary audit. Inside the directory the same
// discipline is kept by hand, one level tighter — every other module here
// imports from THIS file, never from the SDK — so the whole vendor surface this
// adapter depends on is the list of names below and can be read in one screen.
//
// WHY THAT MATTERS MORE THAN USUAL HERE. WIN-271 also moves the SDK from the
// audited 4.34 line to the current stable 4.40 line, and the thing that makes
// such a move reviewable is a SMALL, ENUMERATED surface: four functions and one
// error class. `oracle-4-34.test.ts` re-imports the SAME four names from a
// devDependency pinned at 4.34.0 and asserts both lines answer identically on
// every fixture, so the upgrade is evidenced rather than assumed.
//
// ROLLBACK IS ONE LITERAL. `@chat-adapter/slack` appears as a version in exactly
// one place — this package's `package.json` — because no other package in the
// V1 tree may name it. Reverting `^4.40.0` to `^4.34.0` there is the whole
// rollback; nothing below changes, because nothing below names a version.

export {
  parseSlackWebhookBody,
  verifySlackSignature,
  SlackWebhookVerificationError,
} from "@chat-adapter/slack/webhook";

export type { SlackWebhookPayload } from "@chat-adapter/slack/webhook";

export {
  SlackApiError,
  callSlackApi,
  postSlackMessage,
  updateSlackMessage,
} from "@chat-adapter/slack/api";

export type { SlackPostedMessage } from "@chat-adapter/slack/api";
