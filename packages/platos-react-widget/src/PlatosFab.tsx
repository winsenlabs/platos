import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IdentityForm } from "./IdentityForm.js";
import { usePlatosChat } from "./usePlatosChat.js";
import type {
  ClassNames,
  PlatosFabProps,
  Position,
  ThemeTokens,
  VisitorIdentity,
} from "./types.js";

const DEFAULT_STORAGE_KEY = "platos-widget-identity";

const POSITION_OFFSETS: Record<Position, React.CSSProperties> = {
  "bottom-right": { right: 24, bottom: 24 },
  "bottom-left": { left: 24, bottom: 24 },
  "top-right": { right: 24, top: 24 },
  "top-left": { left: 24, top: 24 },
};

function themeTokensToStyle(t: ThemeTokens | undefined): React.CSSProperties {
  if (!t) return {};
  const out: Record<string, string> = {};
  if (t.primary) out["--platos-color-primary"] = t.primary;
  if (t.background) out["--platos-color-bg"] = t.background;
  if (t.foreground) out["--platos-color-fg"] = t.foreground;
  if (t.muted) out["--platos-color-muted"] = t.muted;
  if (t.border) out["--platos-color-border"] = t.border;
  if (t.assistantBubble) out["--platos-color-bubble-assistant"] = t.assistantBubble;
  if (t.userBubble) out["--platos-color-bubble-user"] = t.userBubble;
  if (t.radius) out["--platos-radius"] = t.radius;
  if (t.fontFamily) out["--platos-font-family"] = t.fontFamily;
  return out as React.CSSProperties;
}

function loadIdentity(key: string | null): VisitorIdentity | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as VisitorIdentity) : null;
  } catch {
    return null;
  }
}

function saveIdentity(key: string | null, id: VisitorIdentity): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(id));
  } catch {
    // storage blocked — chat still works for this session
  }
}

/**
 * `<PlatosFab>` — floating chat button + panel for any React app.
 *
 * Three identity flows depending on how you wire it up:
 *
 *   1. Anonymous public widget (form):
 *        <PlatosFab baseUrl agentId tokenUrl="/api/platos-session" />
 *      Visitor sees a name/email form, then chats. Your tokenUrl mints a
 *      session token signed with your entity's serviceSecret, embedding
 *      `userMeta: { name, email }` so the agent surfaces them as
 *      {{user.name}}/{{user.email}} and the trace columns get populated.
 *
 *   2. Anonymous + email-verified (OTP):
 *        <PlatosFab ... verifyEmail otpEndpoints={{ sendUrl, verifyUrl }} />
 *      Adds an OTP gate before chat. Customer-side endpoints generate +
 *      verify the code (the README has paste-ready code using Resend).
 *
 *   3. Backend-authenticated:
 *        <PlatosFab ... sessionToken={mySessionToken} />
 *      OR
 *        <PlatosFab ... identityMode="preset" identity={{ name, email }}
 *          tokenUrl="/api/platos-session" />
 *      No form, dive into chat. Use this when your app already knows the
 *      user.
 *
 * The widget exposes browser-safe per-turn options via `perTurn`:
 * dynamicBlocks, modelLabel, contextType/Id, and attachmentIds. The widget
 * forwards those options on every send.
 */
export function PlatosFab(props: PlatosFabProps) {
  const {
    baseUrl,
    agentId,
    sessionToken,
    tokenUrl,
    identityMode = "form",
    identity: presetIdentity,
    verifyEmail,
    otpEndpoints,
    storageKey = DEFAULT_STORAGE_KEY,
    perTurn,
    position = "bottom-right",
    width = "380px",
    height = "560px",
    theme = "auto",
    themeTokens,
    classNames = {},
    avatar,
    title,
    subtitle,
    greeting = "Hi! Tell me a bit about yourself and we'll get started.",
    inputPlaceholder = "Type a message…",
    defaultOpen = false,
    hotkey = true,
    onOpen,
    onClose,
    onIdentity,
    onError,
  } = props;

  const [open, setOpen] = useState(defaultOpen);
  const [identity, setIdentity] = useState<VisitorIdentity | null>(() => {
    if (sessionToken) return null; // not needed when token is supplied
    if (identityMode === "anonymous") return { name: "", email: "" };
    if (identityMode === "preset" && presetIdentity) return presetIdentity;
    return loadIdentity(storageKey);
  });

  const chat = usePlatosChat({
    baseUrl,
    agentId,
    sessionToken,
    tokenUrl,
    identity: identity ?? undefined,
    perTurn,
    onError,
  });

  const onSubmitIdentity = useCallback(
    (id: VisitorIdentity) => {
      saveIdentity(storageKey, id);
      setIdentity(id);
      onIdentity?.(id);
    },
    [storageKey, onIdentity],
  );

  // ⌘K / Ctrl+K hotkey + Esc close.
  useEffect(() => {
    if (!hotkey) return;
    const handler = (ev: KeyboardEvent) => {
      const isCmdK =
        (ev.metaKey || ev.ctrlKey) && (ev.key === "k" || ev.key === "K");
      if (isCmdK) {
        ev.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hotkey]);

  useEffect(() => {
    if (open) onOpen?.();
    else onClose?.();
  }, [open, onOpen, onClose]);

  // Auto-scroll to bottom on new messages.
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const onSend = useCallback(async () => {
    if (!draft.trim()) return;
    const text = draft;
    setDraft("");
    await chat.send(text);
  }, [draft, chat]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend],
  );

  const themeStyle = useMemo(() => themeTokensToStyle(themeTokens), [themeTokens]);
  const dataTheme =
    theme === "auto" ? undefined : theme; // CSS handles auto via prefers-color-scheme

  const headerTitle = title ?? "Chat";
  const headerSub = subtitle;

  const needsIdentity =
    !sessionToken &&
    identityMode === "form" &&
    (!identity || (verifyEmail && !identity.verified));

  return (
    <div
      className="platos-widget-root"
      data-platos-theme={dataTheme}
      style={{ ...themeStyle, ...POSITION_OFFSETS[position] }}
    >
      <button
        type="button"
        className={["platos-widget-fab", classNames.fab].filter(Boolean).join(" ")}
        aria-label={open ? "Close chat" : "Open chat"}
        title={hotkey ? "Chat · ⌘K" : "Chat"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <CloseIcon />
        ) : typeof avatar === "string" ? (
          <img src={avatar} alt="" />
        ) : avatar ? (
          avatar
        ) : (
          <ChatIcon />
        )}
      </button>

      <div
        className={["platos-widget-panel", classNames.panel]
          .filter(Boolean)
          .join(" ")}
        data-open={open}
        style={{ width, height }}
        role="dialog"
        aria-hidden={!open}
      >
        <header
          className={["platos-widget-header", classNames.header]
            .filter(Boolean)
            .join(" ")}
        >
          {typeof avatar === "string" ? (
            <img src={avatar} alt="" className="platos-widget-avatar" />
          ) : avatar ? (
            <span className="platos-widget-avatar">{avatar}</span>
          ) : null}
          <div className="platos-widget-header-text">
            <strong>{headerTitle}</strong>
            {headerSub && <small>{headerSub}</small>}
          </div>
          <button
            type="button"
            className="platos-widget-close"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </header>

        {needsIdentity ? (
          <div
            className={[
              "platos-widget-identity-wrapper",
              classNames.identityForm,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <IdentityForm
              initialName={identity?.name}
              initialEmail={identity?.email}
              verifyEmail={verifyEmail}
              otpEndpoints={otpEndpoints}
              onSubmit={onSubmitIdentity}
              greeting={greeting}
            />
          </div>
        ) : (
          <>
            <div
              ref={messagesRef}
              className={["platos-widget-messages", classNames.messages]
                .filter(Boolean)
                .join(" ")}
            >
              {chat.messages.length === 0 && (
                <div className="platos-widget-empty">{greeting}</div>
              )}
              {chat.messages.map((m) => (
                <div
                  key={m.id}
                  className={[
                    "platos-widget-bubble",
                    `platos-widget-bubble--${m.role}`,
                    m.role === "assistant"
                      ? classNames.assistantBubble
                      : classNames.userBubble,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-streaming={m.streaming ? "true" : undefined}
                >
                  {m.content}
                  {m.streaming && <span className="platos-widget-cursor" />}
                  {/* Thumbs up/down — only on persisted assistant messages
                      (serverId present, not mid-stream). Optimistic via
                      chat.rate(); toggling the active vote clears it. */}
                  {m.role === "assistant" && !m.streaming && m.serverId && (
                    <div className="platos-widget-rating">
                      <button
                        type="button"
                        className="platos-widget-rate-btn"
                        aria-label="Good response"
                        aria-pressed={m.rating === 1}
                        data-active={m.rating === 1 ? "true" : undefined}
                        onClick={() => void chat.rate(m.id, "up")}
                      >
                        {"\u{1F44D}"}
                      </button>
                      <button
                        type="button"
                        className="platos-widget-rate-btn"
                        aria-label="Bad response"
                        aria-pressed={m.rating === -1}
                        data-active={m.rating === -1 ? "true" : undefined}
                        onClick={() => void chat.rate(m.id, "down")}
                      >
                        {"\u{1F44E}"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {chat.error && (
                <div className="platos-widget-error">{chat.error.message}</div>
              )}
            </div>

            <div
              className={["platos-widget-input-area", classNames.inputArea]
                .filter(Boolean)
                .join(" ")}
            >
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={inputPlaceholder}
                rows={1}
                className={["platos-widget-textarea", classNames.input]
                  .filter(Boolean)
                  .join(" ")}
                disabled={chat.status === "streaming"}
              />
              <button
                type="button"
                onClick={onSend}
                disabled={!draft.trim() || chat.status === "streaming"}
                className={[
                  "platos-widget-send",
                  classNames.sendButton,
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label="Send"
              >
                <SendIcon />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path
        d="M4 5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="m6 6 12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="m4 12 16-8-7 16-2-7-7-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
