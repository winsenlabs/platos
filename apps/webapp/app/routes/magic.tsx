import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { commitOperatorSession, operatorAuth } from "~/services/auth.server";
export async function loader({ request }: LoaderFunctionArgs) { const token=new URL(request.url).searchParams.get("token"); if(!token) throw redirect("/login"); try { const result=await operatorAuth.consumeMagicLink(token); return redirect("/", { headers: { "Set-Cookie": await commitOperatorSession(result.token,result.expiresAt) } }); } catch { throw redirect("/login?error=invalid-link"); } }
