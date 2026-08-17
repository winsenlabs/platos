import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { OrganizationRole } from "@platos/database";
import { ExclamationTriangleIcon, FolderIcon, TrashIcon } from "@heroicons/react/20/solid";
import { type ActionFunctionArgs, json, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, type MetaFunction, useActionData, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { clearCurrentProject } from "~/services/dashboardPreferences.server";
import { requireUser } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationSettingsPath,
  rootPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Organization settings | Platos" }];

async function requireOrganizationAdmin(organizationSlug: string, userId: string) {
  const membership = await prisma.organizationMembership.findFirst({
    where: {
      userId,
      deactivatedAt: null,
      role: { in: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
      organization: { slug: organizationSlug, archivedAt: null },
    },
    include: { organization: true },
  });
  if (!membership) throw new Response("Not found", { status: 404 });
  return membership;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const membership = await requireOrganizationAdmin(organizationSlug, user.id);
  return typedjson({ organization: membership.organization, role: membership.role });
};

function createSchema(
  constraints: {
    getSlugMatch?: (slug: string) => { isMatch: boolean; organizationSlug: string };
  } = {}
) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("rename"),
      organizationName: z
        .string()
        .trim()
        .min(3, "Organization name must have at least 3 characters")
        .max(50),
    }),
    z.object({
      action: z.literal("archive"),
      organizationSlug: z.string().superRefine((slug, ctx) => {
        if (!constraints.getSlugMatch) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: conform.VALIDATION_UNDEFINED });
          return;
        }
        const match = constraints.getSlugMatch(slug);
        if (!match.isMatch) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The slug must match ${match.organizationSlug}`,
          });
        }
      }),
    }),
  ]);
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const membership = await requireOrganizationAdmin(organizationSlug, user.id);
  const formData = await request.formData();
  const submission = parse(formData, {
    schema: createSchema({
      getSlugMatch: (slug) => ({ isMatch: slug === organizationSlug, organizationSlug }),
    }),
  });

  if (!submission.value || submission.intent !== "submit") return json(submission);

  if (submission.value.action === "rename") {
    await prisma.organization.update({
      where: { id: membership.organizationId },
      data: { name: submission.value.organizationName },
    });
    return redirectWithSuccessMessage(
      organizationSettingsPath({ slug: organizationSlug }),
      request,
      `Organization renamed to ${submission.value.organizationName}`
    );
  }

  if (membership.role !== OrganizationRole.OWNER) {
    return json({ errors: { body: "Only an organization owner can archive this organization" } }, { status: 403 });
  }

  const archivedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.environment.updateMany({
      where: { project: { organizationId: membership.organizationId } },
      data: { archivedAt },
    });
    await tx.project.updateMany({
      where: { organizationId: membership.organizationId },
      data: { archivedAt },
    });
    await tx.organization.update({
      where: { id: membership.organizationId },
      data: { archivedAt },
    });
  });
  await clearCurrentProject({ user });
  return redirectWithSuccessMessage(rootPath(), request, "Organization archived");
};

export default function Page() {
  const { organization, role } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData<typeof action>();
  const navigation = useNavigation();
  const [renameForm, { organizationName }] = useForm({
    id: "rename-organization",
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate: ({ formData }) => parse(formData, { schema: createSchema() }),
  });
  const [archiveForm, { organizationSlug }] = useForm({
    id: "archive-organization",
    lastSubmission: lastSubmission as any,
    shouldValidate: "onInput",
    shouldRevalidate: "onSubmit",
    onValidate: ({ formData }) =>
      parse(formData, {
        schema: createSchema({
          getSlugMatch: (slug) => ({
            isMatch: slug === organization.slug,
            organizationSlug: organization.slug,
          }),
        }),
      }),
  });
  const isRenameLoading =
    navigation.formData?.get("action") === "rename" && navigation.state !== "idle";
  const isArchiveLoading =
    navigation.formData?.get("action") === "archive" && navigation.state !== "idle";

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={`${organization.name} organization settings`} />
      </NavBar>
      <PageBody>
        <MainHorizontallyCenteredContainer>
          <div className="mb-3 border-b border-grid-dimmed pb-3">
            <Header2>Settings</Header2>
          </div>
          <div className="flex flex-col gap-6">
            <Form method="post" {...renameForm.props}>
              <input type="hidden" name="action" value="rename" />
              <Fieldset className="gap-y-0">
                <InputGroup fullWidth>
                  <Label htmlFor={organizationName.id}>Organization name</Label>
                  <Input
                    {...conform.input(organizationName, { type: "text" })}
                    defaultValue={organization.name}
                    placeholder="Your organization name"
                    icon={FolderIcon}
                    autoFocus
                  />
                  <FormError id={organizationName.errorId}>{organizationName.error}</FormError>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      variant="secondary/small"
                      disabled={isRenameLoading}
                      LeadingIcon={isRenameLoading ? SpinnerWhite : undefined}
                    >
                      Rename organization
                    </Button>
                  }
                  className="border-t-0"
                />
              </Fieldset>
            </Form>

            {role === OrganizationRole.OWNER ? (
              <div>
                <Header2 spacing>Danger zone</Header2>
                <Form
                  method="post"
                  {...archiveForm.props}
                  className="w-full rounded-sm border border-rose-500/40"
                >
                  <input type="hidden" name="action" value="archive" />
                  <Fieldset className="p-4">
                    <InputGroup>
                      <Label htmlFor={organizationSlug.id}>Archive organization</Label>
                      <Input
                        {...conform.input(organizationSlug, { type: "text" })}
                        placeholder="Your organization slug"
                        icon={ExclamationTriangleIcon}
                        fullWidth
                      />
                      <FormError id={organizationSlug.errorId}>{organizationSlug.error}</FormError>
                      <FormError>{archiveForm.error}</FormError>
                      <Hint>
                        Archiving removes this organization and its projects from active navigation.
                        Type <InlineCode variant="extra-small">{organization.slug}</InlineCode> to
                        confirm.
                      </Hint>
                    </InputGroup>
                    <FormButtons
                      confirmButton={
                        <Button
                          type="submit"
                          variant="danger/small"
                          LeadingIcon={isArchiveLoading ? SpinnerWhite : TrashIcon}
                          leadingIconClassName="text-white"
                          disabled={isArchiveLoading}
                        >
                          Archive organization
                        </Button>
                      }
                    />
                  </Fieldset>
                </Form>
              </div>
            ) : null}
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
