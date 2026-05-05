import { useCallback, useState } from "react";
import type { OtpEndpoints, VisitorIdentity } from "./types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface IdentityFormProps {
  initialName?: string;
  initialEmail?: string;
  verifyEmail?: boolean;
  otpEndpoints?: OtpEndpoints;
  onSubmit: (identity: VisitorIdentity) => void;
  greeting?: string;
}

/**
 * Two-stage form: name+email → (optional) OTP verification → onSubmit.
 *
 * When `verifyEmail` is on, the form expects a customer backend with two
 * endpoints:
 *   POST {sendUrl}   { email }            → 204 (sends 6-digit code via Resend)
 *   POST {verifyUrl} { email, code }      → 200 { token } (or 401 on bad code)
 *
 * The widget only orchestrates the flow; OTP generation, storage, rate
 * limiting, and send-via-Resend live on the customer's backend (sample
 * code in the README).
 */
export function IdentityForm(props: IdentityFormProps) {
  const [name, setName] = useState(props.initialName ?? "");
  const [email, setEmail] = useState(props.initialEmail ?? "");
  const [stage, setStage] = useState<"identity" | "otp">("identity");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submitIdentity = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setErr(null);
      const trimmedName = name.trim();
      if (!trimmedName) return setErr("Please enter your name.");
      if (!EMAIL_RE.test(email)) return setErr("Please enter a valid email.");

      // OTP flow — ask the customer's backend to email a code, then collect it.
      if (props.verifyEmail) {
        if (!props.otpEndpoints) {
          return setErr(
            "Email verification is enabled but otpEndpoints is missing.",
          );
        }
        try {
          setBusy(true);
          const res = await fetch(props.otpEndpoints.sendUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(text || `Send failed (${res.status})`);
          }
          setStage("otp");
        } catch (ex) {
          setErr(ex instanceof Error ? ex.message : String(ex));
        } finally {
          setBusy(false);
        }
        return;
      }

      // No OTP — submit immediately.
      props.onSubmit({ name: trimmedName, email });
    },
    [name, email, props],
  );

  const submitOtp = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      setErr(null);
      if (!/^\d{6}$/.test(code))
        return setErr("Enter the 6-digit code from your email.");
      try {
        setBusy(true);
        const res = await fetch(props.otpEndpoints!.verifyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Verify failed (${res.status})`);
        }
        // Backend may return { token } so the widget skips its own mint —
        // we ignore it here and let the widget's tokenUrl flow re-fetch
        // (verified=true now). Future v0.2: thread the verified token through.
        props.onSubmit({ name: name.trim(), email, verified: true });
      } catch (ex) {
        setErr(ex instanceof Error ? ex.message : String(ex));
      } finally {
        setBusy(false);
      }
    },
    [code, email, name, props],
  );

  if (stage === "otp") {
    return (
      <form
        onSubmit={submitOtp}
        className="platos-widget-identity"
        data-stage="otp"
      >
        <p className="platos-widget-greeting">
          We sent a 6-digit code to <strong>{email}</strong>. Enter it below to
          continue.
        </p>
        <input
          className="platos-widget-input"
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder="123456"
          autoFocus
          disabled={busy}
        />
        {err && <div className="platos-widget-error">{err}</div>}
        <div className="platos-widget-form-actions">
          <button
            type="button"
            onClick={() => setStage("identity")}
            disabled={busy}
            className="platos-widget-button-secondary"
          >
            Back
          </button>
          <button
            type="submit"
            disabled={busy}
            className="platos-widget-button-primary"
          >
            {busy ? "Verifying…" : "Verify & start chat"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={submitIdentity}
      className="platos-widget-identity"
      data-stage="identity"
    >
      {props.greeting && (
        <p className="platos-widget-greeting">{props.greeting}</p>
      )}
      <label>
        <span className="platos-widget-label">Name</span>
        <input
          className="platos-widget-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoFocus
          disabled={busy}
        />
      </label>
      <label>
        <span className="platos-widget-label">Email</span>
        <input
          className="platos-widget-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          disabled={busy}
        />
      </label>
      {err && <div className="platos-widget-error">{err}</div>}
      <button
        type="submit"
        disabled={busy}
        className="platos-widget-button-primary"
      >
        {busy
          ? "Sending code…"
          : props.verifyEmail
          ? "Send verification code"
          : "Start chat"}
      </button>
    </form>
  );
}
