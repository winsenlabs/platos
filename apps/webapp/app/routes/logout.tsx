import { type ActionFunction, type LoaderFunction } from "@remix-run/node";
import { logout } from "~/services/session.server";

export const action: ActionFunction = async ({ request }) => {
  return logout(request);
};

export const loader: LoaderFunction = async ({ request }) => {
  return logout(request);
};
