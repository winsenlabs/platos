import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { clearOperatorSession, operatorAuth, readOperatorToken } from "~/services/auth.server";
async function end(request: Request) { const token=await readOperatorToken(request); if(token) await operatorAuth.revokeOperatorSession(token).catch(()=>false); return redirect("/login", { headers: { "Set-Cookie": await clearOperatorSession() } }); }
export const action=({request}:ActionFunctionArgs)=>end(request); export const loader=({request}:LoaderFunctionArgs)=>end(request);
