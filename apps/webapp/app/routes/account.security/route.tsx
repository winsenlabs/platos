import { type MetaFunction } from "@remix-run/react";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { MfaSetup } from "../resources.account.mfa.setup/route";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { prisma } from "~/db.server";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Security | Platos`,
    },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const mfa = await prisma.operatorMfaTotp.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });

  return typedjson({
    isEnabled: Boolean(mfa?.enabledAt),
  });
}

export default function Page() {
  const { isEnabled } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Security" />
      </NavBar>

      <PageBody>
        <MainHorizontallyCenteredContainer className="grid place-items-center overflow-visible">
          <div className="mb-3 w-full border-b border-grid-dimmed pb-3">
            <Header2>Security</Header2>
          </div>
          <MfaSetup isEnabled={isEnabled} />
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
