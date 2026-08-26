import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { env } from "~/env.server";
import { commitOperatorSession, operatorAuth, optionalOperator } from "~/services/auth.server";

export async function loader({ request }: LoaderFunctionArgs) { if (await optionalOperator(request)) throw redirect("/"); return null; }
async function sendMagicLink(email: string, link: string) {
  if (!env.RESEND_API_KEY) return false;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.FROM_EMAIL, to: [email], subject: "Sign in to Platos", text: `Sign in to Platos: ${link}` }) });
  return response.ok;
}
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData(); const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ ok: false, message: "Enter a valid email address" }, { status: 400 });
  try {
    const issued = await operatorAuth.issueMagicLink({ email, rateLimitIdentifier: `dashboard:${email}` });
    const direct = env.NODE_ENV !== "production" && (env.BACKDOOR_PLATOS_DEV === "1" || env.PLATOS_TEST_MODE === "1") && (!env.BACKDOOR_PLATOS_DEV_EMAIL || env.BACKDOOR_PLATOS_DEV_EMAIL === email);
    if (direct) { const session = await operatorAuth.consumeMagicLink(issued.token); return redirect("/", { headers: { "Set-Cookie": await commitOperatorSession(session.token, session.expiresAt) } }); }
    const link = new URL("/magic", env.LOGIN_ORIGIN); link.searchParams.set("token", issued.token);
    const sent = await sendMagicLink(email, link.toString());
    return json({ ok: true, message: sent ? "Check your inbox for a sign-in link." : "Email delivery is not configured. Ask an operator to configure RESEND_API_KEY." });
  } catch {
    return json({ ok: false, message: "Sign in is temporarily unavailable" }, { status: 503 });
  }
}
export default function Login() {
  const result = useActionData<typeof action>();

  return (
    <main className="grid min-h-screen place-items-center bg-background-dimmed p-6 text-text-bright">
      <div className="w-full max-w-sm rounded-xl border border-grid-bright bg-background-bright p-6">
        <img
          src="/images/platos-logotype.png"
          alt="Platos"
          width={280}
          height={80}
          className="h-auto w-48"
        />
        <h1 className="mt-6 text-2xl font-semibold">Sign in to Platos</h1>
        <p className="mt-2 text-sm text-text-dimmed">Canonical operator accounts use short-lived magic links.</p>
        <Form method="post" className="mt-6">
          <label className="text-sm">
            Email
            <input name="email" type="email" required className="mt-2 w-full rounded border border-grid-bright bg-charcoal-900 px-3 py-2" />
          </label>
          <button className="mt-4 w-full rounded bg-indigo-500 px-4 py-2 text-sm text-white">Send sign-in link</button>
        </Form>
        {result && <p className="mt-4 text-sm text-text-dimmed">{result.message}</p>}
      </div>
    </main>
  );
}
