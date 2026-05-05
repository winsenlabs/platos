/**
 * @platosdev/react-widget — public type surface.
 */

export interface VisitorIdentity {
  /** Display name shown in headers / passed as `userMeta.name`. */
  name: string;
  /** Email — passed as `userMeta.email`, used for OTP verification when enabled. */
  email: string;
  /** When `true`, the email has been verified through the OTP flow. */
  verified?: boolean;
}

export type IdentityMode = "form" | "anonymous" | "preset";

export interface PerTurnOptions {
  /** Per-turn dynamic content keys. Resolved into the prompt's dynamic blocks. */
  dynamicBlocks?: Record<string, string>;
  /** Selects a named route from the agent's `modelRoutes` config (e.g. "fast"). */
  modelLabel?: string;
  /** Bind the turn to a specific entity / connection. */
  contextType?: string;
  contextId?: string;
  /** Pre-uploaded MinIO attachment ids to attach to this turn. */
  attachmentIds?: string[];
  /**
   * Postman-mode session-context override. Lets you replace the agent's
   * resolved sessionContext for this single turn (e.g. force `entity_ids`
   * narrowing or override a `user.*` key). Server-side this lands at
   * `connections.gateway.ts` as `sessionContextOverride`.
   */
  sessionContextOverride?: Record<string, unknown>;
}

export interface ThemeTokens {
  /** Primary accent (send button, links, focus rings). */
  primary?: string;
  /** Background of the chat panel. */
  background?: string;
  /** Foreground / body text. */
  foreground?: string;
  /** Muted text / placeholder / dimmed copy. */
  muted?: string;
  /** Border + divider colour. */
  border?: string;
  /** Bubble bg for assistant messages. */
  assistantBubble?: string;
  /** Bubble bg for user messages. */
  userBubble?: string;
  /** Border radius (px or any CSS length). */
  radius?: string;
  /** Font family stack. */
  fontFamily?: string;
}

export type Position =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

export interface ClassNames {
  fab?: string;
  panel?: string;
  header?: string;
  messages?: string;
  assistantBubble?: string;
  userBubble?: string;
  inputArea?: string;
  input?: string;
  sendButton?: string;
  identityForm?: string;
}

export interface OtpEndpoints {
  /**
   * POST endpoint on YOUR backend. Receives `{ email }`, sends a 6-digit
   * code via Resend (or any transport), stores a hash against `email`
   * with a short TTL. Should return 204 on success.
   */
  sendUrl: string;
  /**
   * POST endpoint on YOUR backend. Receives `{ email, code }`, verifies
   * the hash, returns `{ token }` (a Platos session token) when valid.
   */
  verifyUrl: string;
}

export interface PlatosFabProps {
  /** Required: the Platos deployment URL. e.g. https://play.platos.dev */
  baseUrl: string;
  /** Required: the agent id. */
  agentId: string;

  // ─── Auth (one path required) ──────────────────────────────────────────
  /**
   * Caller already has a session token. Widget uses it directly. When you
   * supply this, the identity form / OTP flow is skipped.
   */
  sessionToken?: string;
  /**
   * URL on your backend that mints a session token. When supplied (and
   * `sessionToken` is not), the widget POSTs here on first send + on 401
   * to refresh. Body is `{ name?, email?, verified? }` — your backend can
   * use those in the `userMeta` claim it signs into the JWT.
   */
  tokenUrl?: string;

  // ─── Identity collection (only used when sessionToken is missing) ─────
  /**
   * - "form"       (default): show name + email form; submit then chat.
   * - "anonymous": no form, dive straight into chat. The agent must be
   *                public-guest enabled or your tokenUrl must mint
   *                without identity.
   * - "preset"   : you supply `identity` directly via the prop below.
   */
  identityMode?: IdentityMode;
  /** Pre-supplied visitor identity (used with identityMode="preset"). */
  identity?: VisitorIdentity;
  /** When true with identityMode="form", run an OTP flow before opening the chat. */
  verifyEmail?: boolean;
  /** Required when verifyEmail is true. */
  otpEndpoints?: OtpEndpoints;
  /**
   * Local-storage key for caching the visitor identity across visits.
   * Default: "platos-widget-identity". Set to `null` to disable persistence.
   */
  storageKey?: string | null;

  // ─── Per-turn options (forwarded to threads.send on every message) ────
  perTurn?: PerTurnOptions;

  // ─── UI ────────────────────────────────────────────────────────────────
  position?: Position;
  width?: string;
  height?: string;
  /** Light, dark, or follow `prefers-color-scheme`. */
  theme?: "light" | "dark" | "auto";
  /** Inline theme overrides (CSS vars). Granular control. */
  themeTokens?: ThemeTokens;
  /** Pass-through className slots. */
  classNames?: ClassNames;
  /** Avatar / branding shown in the FAB + header. URL or React node. */
  avatar?: string | React.ReactNode;
  /** Header title shown next to the avatar. Default: agent name once loaded. */
  title?: string;
  /** Header subtitle. */
  subtitle?: string;
  /** Greeting shown before the visitor sends their first message. */
  greeting?: string;
  /** Placeholder for the input box. */
  inputPlaceholder?: string;
  /** Initially open. Default: false. */
  defaultOpen?: boolean;
  /** Enable ⌘K / Ctrl+K to toggle. Default: true. */
  hotkey?: boolean;

  // ─── Lifecycle ────────────────────────────────────────────────────────
  onOpen?: () => void;
  onClose?: () => void;
  onIdentity?: (identity: VisitorIdentity) => void;
  onError?: (err: Error) => void;
}
