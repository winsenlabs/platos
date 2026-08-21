import { json,type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { database } from "~/services/database.server";
export async function loader({request,params}:LoaderFunctionArgs){if(!params.organizationSlug||!params.projectParam||!params.envParam)throw new Response("Invalid scope",{status:400});const{scope}=await requireEnvironmentScope({request,organizationSlug:params.organizationSlug,projectSlug:params.projectParam,environmentSlug:params.envParam});const users=await database.endUser.findMany({where:{organizationId:scope.organizationId},select:{id:true,displayName:true,disabledAt:true,createdAt:true,identities:{select:{issuer:true,channel:true,subject:true,verifiedAt:true,disabledAt:true}}},orderBy:{createdAt:"desc"},take:200});return json({surface:"accounts",title:"EndUser accounts",description:"EndUser identities are a distinct principal tier from canonical operator accounts and memberships.",panel:{ok:true as const,data:{users}},provenance:"Canonical EndUser and EndUserIdentity rows"});}
export default function Accounts(){return <M4Surface data={useLoaderData<typeof loader>()}/>;}
