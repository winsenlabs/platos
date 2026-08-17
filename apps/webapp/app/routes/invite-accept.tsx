import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { acceptInvite, getInviteFromToken } from "~/models/member.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { getUser } from "~/services/session.server";
import { redirect } from "@remix-run/server-runtime";
import { organizationPath } from "~/utils/pathBuilder";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getUser(request);

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invalid invite URL. Please ask the person who invited you to send another invite.",
      { ephemeral: false }
    );
  }

  if (!user) {
    return redirect(`/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const invite = await getInviteFromToken({ token });
  if (!invite) {
    return redirectWithErrorMessage(
      "/",
      request,
      "Invite not found. Please ask the person who invited you to send another invite.",
      { ephemeral: false }
    );
  }

  if (invite.email !== user.email) {
    return redirectWithErrorMessage(
      "/",
      request,
      `This invite is for ${invite.email}, but you are logged in as ${user.email}.`,
      { ephemeral: false }
    );
  }

  const { organization } = await acceptInvite({ user, token, request });
  return redirectWithSuccessMessage(
    organizationPath(organization),
    request,
    `You joined ${organization.name}`
  );
}
