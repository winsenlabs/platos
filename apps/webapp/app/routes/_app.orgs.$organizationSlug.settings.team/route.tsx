import { OrganizationRole } from "@platos/database";
import { EnvelopeIcon, NoSymbolIcon, UserPlusIcon } from "@heroicons/react/20/solid";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/node";
import {
  Form,
  type MetaFunction,
  useActionData,
  useNavigation,
} from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  Alert,
  AlertCancel,
  AlertContent,
  AlertDescription,
  AlertFooter,
  AlertHeader,
  AlertTitle,
  AlertTrigger,
} from "~/components/primitives/Alert";
import { Button, ButtonContent, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { $replica } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useUser } from "~/hooks/useUser";
import { changeTeamMemberRole, removeTeamMember } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { TeamPresenter } from "~/presenters/TeamPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  inviteTeamMemberPath,
  organizationTeamPath,
  resendInvitePath,
  revokeInvitePath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Team | Platos" }];

const Params = z.object({ organizationSlug: z.string() });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = Params.parse(params);
  const organization = await $replica.organization.findFirst({
    where: {
      slug: organizationSlug,
      archivedAt: null,
      memberships: { some: { userId, deactivatedAt: null } },
    },
    select: { id: true },
  });
  if (!organization) throw new Response("Not Found", { status: 404 });

  const result = await new TeamPresenter().call({ userId, organizationId: organization.id });
  if (!result) throw new Response("Not Found", { status: 404 });
  return typedjson(result);
};

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remove"), memberId: z.string().uuid() }),
  z.object({
    action: z.literal("change-role"),
    memberId: z.string().uuid(),
    role: z.nativeEnum(OrganizationRole),
  }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = Params.parse(params);
  const organization = await $replica.organization.findFirst({
    where: {
      slug: organizationSlug,
      archivedAt: null,
      memberships: { some: { userId, deactivatedAt: null } },
    },
    select: { id: true },
  });
  if (!organization) throw new Response("Organization not found", { status: 404 });

  const parsed = ActionSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return json({ errors: { body: "Invalid team action" } }, { status: 400 });
  }

  try {
    if (parsed.data.action === "change-role") {
      const updatedMember = await changeTeamMemberRole({
        userId,
        organizationId: organization.id,
        memberId: parsed.data.memberId,
        role: parsed.data.role,
      });
      return redirectWithSuccessMessage(
        organizationTeamPath({ slug: organizationSlug }),
        request,
        `Updated ${updatedMember.user.displayName ?? updatedMember.user.email} to ${roleLabel(updatedMember.role)}`
      );
    }

    const removedMember = await removeTeamMember({
      userId,
      organizationId: organization.id,
      memberId: parsed.data.memberId,
    });
    if (removedMember.userId === userId) {
      return redirectWithSuccessMessage("/", request, "You left the organization");
    }
    return redirectWithSuccessMessage(
      organizationTeamPath(removedMember.organization),
      request,
      `Removed ${removedMember.user.displayName ?? removedMember.user.email} from team`
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      { errors: { body: error instanceof Error ? error.message : "Team update failed" } },
      { status: 400 }
    );
  }
};

type Member = UseDataFunctionReturn<typeof loader>["members"][number];
type Invite = UseDataFunctionReturn<typeof loader>["invites"][number];

function roleLabel(role: OrganizationRole) {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

export default function Page() {
  const { members, invites, limits } = useTypedLoaderData<typeof loader>();
  const user = useUser();
  const organization = useOrganization();
  const currentMembership = members.find((member) => member.user.id === user.id);
  const actorRole = currentMembership?.role;
  const ownerCount = members.filter((member) => member.role === OrganizationRole.OWNER).length;
  const limitReached = limits.used >= limits.limit;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Team" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>Organization ID</Property.Label>
                <Property.Value>{organization.id}</Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>
          {limitReached ? (
            <SimpleTooltip
              button={
                <ButtonContent
                  variant="primary/small"
                  LeadingIcon={UserPlusIcon}
                  className="cursor-not-allowed opacity-50"
                >
                  Invite a team member
                </ButtonContent>
              }
              content={`This organization has reached its ${limits.limit}-member limit`}
              disableHoverableContent
            />
          ) : (
            <LinkButton
              to={inviteTeamMemberPath(organization)}
              variant="primary/small"
              LeadingIcon={UserPlusIcon}
            >
              Invite a team member
            </LinkButton>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="mx-auto max-w-3xl px-4 pb-8 pt-20">
          <Paragraph variant="small" className="mb-6 text-text-dimmed">
            {limits.used} of {limits.limit} active members and pending invitations used.
          </Paragraph>

          {invites.length > 0 ? (
            <>
              <Header2 className="mb-3 mt-4">Pending invites</Header2>
              <ul className="mb-6 flex w-full flex-col divide-y divide-grid-bright border-y border-grid-bright">
                {invites.map((invite) => (
                  <li key={invite.id} className="flex items-center gap-4 py-4">
                    <div className="rounded-md border border-charcoal-750 bg-charcoal-800 p-1.5">
                      <EnvelopeIcon className="size-7 text-text-dimmed" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <Header3>{invite.email}</Header3>
                      <Paragraph variant="small">
                        {roleLabel(invite.role)} invite sent <DateTime date={invite.createdAt} />
                      </Paragraph>
                    </div>
                    <div className="flex grow items-center justify-end gap-x-2">
                      <ResendButton invite={invite} />
                      <RevokeButton invite={invite} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <Header2>Active team members</Header2>
          <ul className="mb-8 mt-3 flex w-full flex-col divide-y divide-grid-bright border-y border-grid-bright">
            {members.map((member) => {
              const canManageOwner = actorRole === OrganizationRole.OWNER;
              const canChangeRole = member.role !== OrganizationRole.OWNER || canManageOwner;
              const isOnlyOwner =
                member.role === OrganizationRole.OWNER && ownerCount === 1;
              return (
                <li key={member.id} className="flex items-center gap-x-4 py-4">
                  <UserAvatar
                    avatarUrl={member.user.avatarUrl}
                    name={member.user.displayName ?? member.user.email}
                    className="size-10"
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Header3 className="truncate">
                      {member.user.displayName ?? member.user.email}{" "}
                      {member.user.id === user.id ? (
                        <span className="text-text-dimmed">(You)</span>
                      ) : null}
                    </Header3>
                    <Paragraph variant="small" className="truncate">
                      {member.user.email}
                    </Paragraph>
                  </div>
                  <div className="flex grow items-center justify-end gap-3">
                    {canChangeRole && !isOnlyOwner ? (
                      <RoleForm member={member} actorRole={actorRole} />
                    ) : (
                      <Paragraph variant="small">{roleLabel(member.role)}</Paragraph>
                    )}
                    <LeaveRemoveButton
                      userId={user.id}
                      member={member}
                      disabled={isOnlyOwner || (!canManageOwner && member.role === OrganizationRole.OWNER)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function RoleForm({ member, actorRole }: { member: Member; actorRole?: OrganizationRole }) {
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("action") === "change-role" &&
    navigation.formData?.get("memberId") === member.id;
  const roles =
    actorRole === OrganizationRole.OWNER
      ? [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.MEMBER]
      : [OrganizationRole.ADMIN, OrganizationRole.MEMBER];
  return (
    <Form method="post" className="flex items-center gap-2">
      <input type="hidden" name="action" value="change-role" />
      <input type="hidden" name="memberId" value={member.id} />
      <select
        name="role"
        defaultValue={member.role}
        aria-label={`Role for ${member.user.email}`}
        className="rounded-sm border border-grid-bright bg-background-bright px-2 py-1 text-sm text-text-bright"
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {roleLabel(role)}
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary/small" disabled={isSubmitting}>
        Save
      </Button>
    </Form>
  );
}

function LeaveRemoveButton({
  userId,
  member,
  disabled,
}: {
  userId: string;
  member: Member;
  disabled: boolean;
}) {
  const organization = useOrganization();
  const isSelf = userId === member.user.id;
  const buttonText = isSelf ? "Leave team" : "Remove from team";
  if (disabled) {
    return (
      <SimpleTooltip
        button={<ButtonContent variant="minimal/small" className="cursor-not-allowed">{buttonText}</ButtonContent>}
        content="An organization must retain an owner"
        disableHoverableContent
      />
    );
  }
  return (
    <RemoveMemberDialog
      member={member}
      buttonText={buttonText}
      title={isSelf ? "Leave this organization?" : `Remove ${member.user.displayName ?? member.user.email}?`}
      description={
        isSelf
          ? `You will no longer have access to ${organization.name}.`
          : `They will no longer have access to ${organization.name}.`
      }
    />
  );
}

function RemoveMemberDialog({
  member,
  buttonText,
  title,
  description,
}: {
  member: Member;
  buttonText: string;
  title: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const actionData = useActionData<typeof action>();
  const actionError =
    actionData &&
    typeof actionData === "object" &&
    "errors" in actionData &&
    actionData.errors &&
    typeof actionData.errors === "object" &&
    "body" in actionData.errors
      ? String(actionData.errors.body)
      : null;
  return (
    <Alert open={open} onOpenChange={setOpen}>
      <AlertTrigger asChild>
        <Button variant="secondary/small">{buttonText}</Button>
      </AlertTrigger>
      <AlertContent>
        <AlertHeader>
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </AlertHeader>
        {actionError ? (
          <Paragraph variant="small" className="text-error">
            {actionError}
          </Paragraph>
        ) : null}
        <AlertFooter>
          <AlertCancel asChild>
            <Button variant="secondary/small">Cancel</Button>
          </AlertCancel>
          <Form method="post" onSubmit={() => setOpen(false)}>
            <input type="hidden" name="action" value="remove" />
            <input type="hidden" name="memberId" value={member.id} />
            <Button type="submit" variant="danger/small">
              {buttonText}
            </Button>
          </Form>
        </AlertFooter>
      </AlertContent>
    </Alert>
  );
}

const RESEND_COOLDOWN_SECONDS = 30;

function ResendButton({ invite }: { invite: Invite }) {
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" &&
    navigation.formAction === resendInvitePath() &&
    navigation.formData?.get("inviteId") === invite.id;
  const previousSubmitting = useRef(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (previousSubmitting.current && !isSubmitting) setCooldown(RESEND_COOLDOWN_SECONDS);
    previousSubmitting.current = isSubmitting;
  }, [isSubmitting]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  return (
    <Form method="post" action={resendInvitePath()} className="flex">
      <input type="hidden" value={invite.id} name="inviteId" />
      <Button type="submit" variant="secondary/small" disabled={isSubmitting || cooldown > 0}>
        {isSubmitting ? "Sending…" : cooldown > 0 ? `Resend in ${cooldown}s` : "Resend invite"}
      </Button>
    </Form>
  );
}

function RevokeButton({ invite }: { invite: Invite }) {
  const organization = useOrganization();
  return (
    <Form method="post" action={revokeInvitePath()} className="flex">
      <input type="hidden" value={invite.id} name="inviteId" />
      <input type="hidden" value={organization.id} name="organizationId" />
      <SimpleTooltip
        button={
          <Button
            type="submit"
            variant="danger/small"
            LeadingIcon={NoSymbolIcon}
            leadingIconClassName="text-white"
            aria-label="Revoke invite"
          />
        }
        content="Revoke invite"
        disableHoverableContent
        asChild
      />
    </Form>
  );
}
