import { json,type LoaderFunctionArgs } from "@remix-run/node";
import { Outlet,useLoaderData } from "@remix-run/react";
import { M4Surface } from "~/components/platos/M4Surface";
import { requireEnvironmentScope } from "~/services/auth.server";
import { database } from "~/services/database.server";
export async function loader({request,params}:LoaderFunctionArgs){if(!params.organizationSlug||!params.projectParam||!params.envParam)throw new Response("Invalid scope",{status:400});const{scope}=await requireEnvironmentScope({request,organizationSlug:params.organizationSlug,projectSlug:params.projectParam,environmentSlug:params.envParam});const variables=await database.environmentVariable.findMany({where:{environmentId:scope.environmentId},select:{id:true,key:true,kind:true,value:true,credentialId:true,version:true,updatedAt:true},orderBy:{key:"asc"}});return json({surface:"variables",title:"Environment variables",description:"Clean Environment-owned values and redacted Credential references.",panel:{ok:true as const,data:{variables:variables.map(v=>({...v,value:v.credentialId?null:v.value,present:Boolean(v.credentialId||v.value)}))}},provenance:"Canonical EnvironmentVariable and Credential metadata"});}
export default function Variables(){const data=useLoaderData<typeof loader>();return <><M4Surface data={data}/><Outlet/></>;}
