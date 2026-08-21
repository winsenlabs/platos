import { redirect,type LoaderFunctionArgs } from "@remix-run/node";export async function loader({params}:LoaderFunctionArgs){throw redirect(`/orgs/${params.organizationSlug}/settings/team`);}
