import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireOperator } from "~/services/auth.server";
export async function loader({request}:LoaderFunctionArgs){return requireOperator(request);}
export default function AppLayout(){return <Outlet/>;}
