import { ArrowLeftIcon, EnvelopeIcon } from "@heroicons/react/20/solid";
import { InboxArrowDownIcon } from "@heroicons/react/24/solid";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { TextLink } from "~/components/primitives/TextLink";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import { setRedirectTo, commitSession as commitRedirectSession } from "~/services/redirectTo.server";
import {
  checkMagicLinkEmailRateLimit,
  checkMagicLinkEmailDailyRateLimit,
  MagicLinkRateLimitError,
} from "~/services/magicLinkRateLimiter.server";
// `logger` from `@platos/core/v3` is the TASK-scoped LoggerAPI — it
// delegates to a NoopTaskLogger outside a trigger.dev task run, so every
// `logger.info()` silently no-ops in webapp request handlers. Use the
// webapp's own logger (pino-backed, singleton) instead. `tryCatch` stays
// on the core import — that helper is pure.
import { tryCatch } from "@platos/core/v3";
import { logger } from "~/services/logger.server";
import { env } from "~/env.server";
import { getUserId } from "~/services/session.server";
import {
  authEmailRateLimitIdentifier,
  platosDashboardAuth,
} from "~/services/platosDashboardAuth.server";
import { sendDashboardMagicLink } from "~/services/email.server";

export const meta: MetaFunction = ({ matches }) => {
  const parentMeta = matches
    .flatMap((match) => match.meta ?? [])
    .filter((meta) => {
      if ("title" in meta) return false;
      if ("name" in meta && meta.name === "viewport") return false;
      return true;
    });

  return [
    ...parentMeta,
    { title: `Login to Platos` },
    {
      name: "viewport",
      content: "width=device-width,initial-scale=1",
    },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  if (await getUserId(request)) throw redirect("/");

  const session = await getUserSession(request);
  const error = session.get("auth:error");

  // Get redirectTo from URL params and store in session if present
  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirectTo");
  const headers = new Headers();
  
  if (redirectTo) {
    const redirectSession = await setRedirectTo(request, redirectTo);
    headers.append("Set-Cookie", await commitRedirectSession(redirectSession));
  }

  let magicLinkError: string | undefined;
  if (error) {
    if ("message" in error) {
      magicLinkError = error.message;
    } else {
      magicLinkError = JSON.stringify(error, null, 2);
    }
  }

  headers.append("Set-Cookie", await commitSession(session));

  return typedjson(
    {
      magicLinkSent: session.has("triggerdotdev:magiclink"),
      magicLinkError,
    },
    {
      headers,
    }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const clonedRequest = request.clone();

  const payload = Object.fromEntries(await clonedRequest.formData());

  const data = z
    .discriminatedUnion("action", [
      z.object({
        action: z.literal("send"),
        email: z.string().trim().toLowerCase(),
      }),
      z.object({
        action: z.literal("reset"),
      }),
    ])
    .parse(payload);

  switch (data.action) {
    case "send": {
      const { email } = data;

      const [error] = env.LOGIN_RATE_LIMITS_ENABLED
        ? await tryCatch(
            Promise.all([
              checkMagicLinkEmailRateLimit(email),
              checkMagicLinkEmailDailyRateLimit(email),
            ])
          )
        : [null];

      if (error) {
        if (error instanceof MagicLinkRateLimitError) {
          logger.warn("Login magic link rate limit exceeded", {
            email,
            error,
          });
        } else {
          logger.error("Failed sending login magic link", {
            email,
            error,
          });
        }

        const errorMessage =
          error instanceof MagicLinkRateLimitError
            ? "Too many magic link requests. Please try again shortly."
            : "Failed sending magic link. Please try again shortly.";

        const session = await getUserSession(request);
        session.set("auth:error", {
          message: errorMessage,
        });

        const headers = new Headers();
        headers.append("Set-Cookie", await commitSession(session));
        return redirect("/login/magic", { headers });
      }

      try {
        const issued = await platosDashboardAuth.issueMagicLink({
          email,
          rateLimitIdentifier: authEmailRateLimitIdentifier(email),
        });
        const link = new URL("/magic", env.LOGIN_ORIGIN);
        link.searchParams.set("token", issued.token);
        await sendDashboardMagicLink(email, link.toString());

        const session = await getUserSession(request);
        session.set("triggerdotdev:magiclink", true);
        return redirect("/login/magic", {
          headers: { "Set-Cookie": await commitSession(session) },
        });
      } catch (err: any) {
        if (err instanceof Response) {
          throw err;
        }
        throw err;
      }
    }
    case "reset":
    default: {
      data.action satisfies "reset";

      const session = await getUserSession(request);
      session.unset("triggerdotdev:magiclink");

      return redirect("/login/magic", {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      });
    }
  }
}

export default function LoginMagicLinkPage() {
  const { magicLinkSent, magicLinkError } = useTypedLoaderData<typeof loader>();
  const navigate = useNavigation();

  const isLoading =
    (navigate.state === "loading" || navigate.state === "submitting") &&
    navigate.formAction !== undefined &&
    navigate.formData?.get("action") === "send";

  return (
    <LoginPageLayout>
      <Form method="post">
        <div className="flex flex-col items-center justify-center">
          {magicLinkSent ? (
            <>
              <Header1 className="pb-6 text-center text-xl font-normal leading-7 md:text-xl lg:text-2xl">
                We've sent you a magic link!
              </Header1>
              <Fieldset className="flex w-full flex-col items-center gap-y-2">
                <InboxArrowDownIcon className="mb-4 h-12 w-12 text-indigo-500" />
                <Paragraph className="mb-6 text-center">
                  We sent you an email which contains a magic link that will log you in to your
                  account.
                </Paragraph>
                <FormButtons
                  cancelButton={
                    <Button
                      type="submit"
                      name="action"
                      value="reset"
                      variant="minimal/small"
                      LeadingIcon={ArrowLeftIcon}
                      leadingIconClassName="text-text-dimmed group-hover:text-text-bright transition"
                      data-action="re-enter email"
                    >
                      Re-enter email
                    </Button>
                  }
                  confirmButton={
                    <LinkButton
                      to="/login"
                      variant="minimal/small"
                      data-action="log in using another option"
                    >
                      Log in using another option
                    </LinkButton>
                  }
                />
                <Paragraph variant="extra-small" className="mt-4 text-center">
                  While you wait, take a look at the{" "}
                  <TextLink
                    href="https://platos.dev/guides/quickstart"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    quickstart guide ↗
                  </TextLink>
                  .
                </Paragraph>
              </Fieldset>
            </>
          ) : (
            <>
              <Header1 className="pb-4 font-semibold sm:text-2xl md:text-3xl lg:text-4xl">
                Welcome
              </Header1>
              <Paragraph variant="base" className="mb-6 text-center">
                Create an account or login using email
              </Paragraph>
              <Fieldset className="flex w-full flex-col items-center gap-y-2">
                <InputGroup>
                  <Input
                    type="email"
                    name="email"
                    spellCheck={false}
                    placeholder="Email Address"
                    variant="large"
                    required
                    autoFocus
                  />
                </InputGroup>

                <Button
                  name="action"
                  value="send"
                  type="submit"
                  variant="primary/large"
                  disabled={isLoading}
                  fullWidth
                  data-action="send a magic link"
                >
                  {isLoading ? (
                    <Spinner className="mr-2 size-5" color="white" />
                  ) : (
                    <EnvelopeIcon className="mr-2 size-5 text-text-bright" />
                  )}
                  {isLoading ? (
                    <span className="text-text-bright">Sending…</span>
                  ) : (
                    <span className="text-text-bright">Send a magic link</span>
                  )}
                </Button>
                {magicLinkError && <FormError>{magicLinkError}</FormError>}
              </Fieldset>
              <Paragraph variant="extra-small" className="mb-1 mt-6 text-center">
                By continuing you agree to our{" "}
                <TextLink href="https://platos.dev/terms" target="_blank">
                  Terms
                </TextLink>
                {" "}and{" "}
                <TextLink href="https://platos.dev/privacy" target="_blank">
                  Privacy Policy
                </TextLink>
                .
              </Paragraph>
              <Paragraph variant="extra-small" className="mb-4 text-center">
                New to Platos?{" "}
                <TextLink
                  href="https://platos.dev/guides/quickstart"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Read the quickstart guide ↗
                </TextLink>
              </Paragraph>

              <LinkButton
                to="/login"
                variant={"minimal/small"}
                LeadingIcon={ArrowLeftIcon}
                leadingIconClassName="text-text-dimmed group-hover:text-text-bright transition"
                data-action="all login options"
              >
                All login options
              </LinkButton>
            </>
          )}
        </div>
      </Form>
    </LoginPageLayout>
  );
}
