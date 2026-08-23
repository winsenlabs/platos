import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { AppShell } from "~/components/platos/DashboardShell";
import { requireEnvironmentScope } from "~/services/auth.server";
export async function loader({request,params}:LoaderFunctionArgs){if(!params.organizationSlug||!params.projectParam||!params.envParam)throw new Response("Invalid scope",{status:400});const result=await requireEnvironmentScope({request,organizationSlug:params.organizationSlug,projectSlug:params.projectParam,environmentSlug:params.envParam});return json({workspace:result.workspace});}
export default function EnvironmentLayout(){const {workspace}=useLoaderData<typeof loader>();return <AppShell workspace={workspace}/>;}
