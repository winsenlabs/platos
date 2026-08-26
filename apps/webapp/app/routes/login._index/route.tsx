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
    <main className="grid min-h-screen bg-background-bright text-text-bright lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <section className="relative flex min-h-screen flex-col border-grid-bright px-6 py-8 sm:px-10 lg:border-r lg:px-14 lg:py-10">
        <header className="flex justify-center lg:justify-start">
          <a href="/" aria-label="Platos home" className="inline-flex">
            <img
              src="/images/platos-logotype.png"
              alt="Platos"
              width={320}
              height={156}
              className="h-auto w-40"
            />
          </a>
        </header>

        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Operator console</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-0.035em]">Sign in to Platos</h1>
            <p className="mt-4 text-base leading-7 text-text-dimmed">
              No password to remember. We&apos;ll email you a secure link that expires automatically.
            </p>

            <Form method="post" className="mt-10">
              <label htmlFor="operator-email" className="text-sm font-medium">Work email</label>
              <input
                id="operator-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                placeholder="name@company.com"
                className="mt-3 w-full border-0 border-b border-grid-bright bg-transparent px-0 py-3 text-lg text-text-bright outline-none transition placeholder:text-text-dimmed focus:border-indigo-400 focus:ring-0"
              />
              <button className="mt-8 w-full rounded-md bg-indigo-500 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:ring-offset-2 focus:ring-offset-background-bright">
                Continue with email
              </button>
            </Form>

            {result && (
              <p role="status" className={`mt-5 border-l-2 px-4 py-2 text-sm leading-6 ${result.ok ? "border-emerald-400 text-emerald-200" : "border-rose-400 text-rose-200"}`}>
                {result.message}
              </p>
            )}
          </div>
        </div>

        <footer className="text-center text-xs text-text-dimmed lg:text-left">
          Secure passwordless access for Platos operators.
        </footer>
      </section>

      <section className="relative hidden min-h-screen overflow-hidden bg-charcoal-950 lg:flex lg:flex-col lg:justify-between lg:p-14 xl:p-20">
        <div aria-hidden="true" className="absolute inset-0 [background-image:radial-gradient(circle_at_72%_24%,rgba(99,102,241,0.28),transparent_34%),radial-gradient(circle_at_20%_85%,rgba(56,189,248,0.12),transparent_30%)]" />
        <div aria-hidden="true" className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:56px_56px]" />

        <div className="relative flex items-center gap-3 text-xs font-medium uppercase tracking-[0.2em] text-text-dimmed">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.8)]" />
          Production agent infrastructure
        </div>

        <div className="relative max-w-2xl py-16">
          <h2 className="text-6xl font-semibold leading-[1.03] tracking-[-0.05em] text-white xl:text-7xl">
            The only runtime<br />you will ever need
            <span className="text-indigo-400">.</span>
          </h2>
          <p className="mt-8 max-w-xl text-xl leading-8 text-text-dimmed">
            Ship dependable agents with versioning, observability, memory, tools, and governance built into one coherent platform.
          </p>
        </div>

        <div className="relative grid grid-cols-3 border-t border-white/10 pt-6 text-sm">
          {[
            ["01", "Build"],
            ["02", "Deploy"],
            ["03", "Operate"],
          ].map(([number, label]) => (
            <div key={number}>
              <span className="mr-3 font-mono text-xs text-indigo-300">{number}</span>
              <span className="text-text-dimmed">{label}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
