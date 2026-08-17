import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { requireUserId } from "~/services/session.server";

// Hosted onboarding/profile collection is no longer part of the clean User contract.
// Keep the historical URL as a safe redirect for old bookmarks and login redirects.
export async function loader({ request }: LoaderFunctionArgs) {
  await requireUserId(request);
  return redirect("/");
}

export async function action({ request }: ActionFunctionArgs) {
  await requireUserId(request);
  return redirect("/");
}

export default function ConfirmBasicDetailsRedirect() {
  return null;
}
