import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { OrganizationRole, ProjectRole } from "@platos/database";
import { ExclamationTriangleIcon, FolderIcon, TrashIcon } from "@heroicons/react/20/solid";
import { type ActionFunctionArgs, json } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { MainHorizontallyCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { prisma } from "~/db.server";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { organizationPath, v3ProjectPath } from "~/utils/pathBuilder";

function createSchema(
  constraints: {
    getSlugMatch?: (slug: string) => { isMatch: boolean; projectSlug: string };
  } = {}
) {
  return z.discriminatedUnion("action", [
    z.object({
      action: z.literal("rename"),
      projectName: z.string().trim().min(3, "Project name must have at least 3 characters").max(50),
    }),
    z.object({
      action: z.literal("archive"),
      projectSlug: z.string().superRefine((slug, ctx) => {
        if (!constraints.getSlugMatch) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: conform.VALIDATION_UNDEFINED });
          return;
        }
        const match = constraints.getSlugMatch(slug);
        if (!match.isMatch) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `The slug must match ${match.projectSlug}`,
          });
        }
      }),
    }),
  ]);
}

async function requireProjectAdmin(organizationSlug: string, projectSlug: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: {
      slug: projectSlug,
      archivedAt: null,
      organization: { slug: organizationSlug, archivedAt: null },
    },
  });
  if (!project) throw new Response("Project not found", { status: 404 });

  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: project.organizationId, userId } },
    include: {
      projectMemberships: { where: { projectId: project.id }, select: { role: true } },
    },
  });
  const organizationAdmin =
    membership &&
    !membership.deactivatedAt &&
    [OrganizationRole.OWNER, OrganizationRole.ADMIN].includes(membership.role);
  const projectAdmin =
    membership &&
    !membership.deactivatedAt &&
    membership.projectMemberships.some(({ role }) => role === ProjectRole.ADMIN);
  if (!organizationAdmin && !projectAdmin) throw new Response("Forbidden", { status: 403 });
  return project;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = params;
  if (!organizationSlug || !projectParam) {
    return json(
      { errors: { body: "organizationSlug and projectParam are required" } },
      { status: 400 }
    );
  }
  const formData = await request.formData();
  const submission = parse(formData, {
    schema: createSchema({
      getSlugMatch: (slug) => ({ isMatch: slug === projectParam, projectSlug: projectParam }),
    }),
  });
  if (!submission.value || submission.intent !== "submit") return json(submission);

  const project = await requireProjectAdmin(organizationSlug, projectParam, userId);
  if (submission.value.action === "rename") {
    await prisma.project.update({
      where: { id: project.id },
      data: { name: submission.value.projectName },
    });
    return redirectWithSuccessMessage(
      v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }),
      request,
      `Project renamed to ${submission.value.projectName}`
    );
  }

  const archivedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.environment.updateMany({
      where: { projectId: project.id },
      data: { archivedAt },
    });
    await tx.project.update({ where: { id: project.id }, data: { archivedAt } });
  });
  return redirectWithSuccessMessage(
    organizationPath({ slug: organizationSlug }),
    request,
    "Project archived"
  );
};

export default function GeneralSettingsPage() {
  const project = useProject();
  const lastSubmission = useActionData<typeof action>();
  const navigation = useNavigation();
  const [hasRenameFormChanges, setHasRenameFormChanges] = useState(false);
  const [renameForm, { projectName }] = useForm({
    id: "rename-project",
    lastSubmission: lastSubmission as any,
    shouldRevalidate: "onSubmit",
    onValidate: ({ formData }) => parse(formData, { schema: createSchema() }),
  });
  const [archiveForm, { projectSlug }] = useForm({
    id: "archive-project",
    lastSubmission: lastSubmission as any,
    shouldValidate: "onInput",
    shouldRevalidate: "onSubmit",
    onValidate: ({ formData }) =>
      parse(formData, {
        schema: createSchema({
          getSlugMatch: (slug) => ({ isMatch: slug === project.slug, projectSlug: project.slug }),
        }),
      }),
  });
  const isRenameLoading =
    navigation.formData?.get("action") === "rename" && navigation.state !== "idle";
  const isArchiveLoading =
    navigation.formData?.get("action") === "archive" && navigation.state !== "idle";
  const [archiveInputValue, setArchiveInputValue] = useState("");

  return (
    <MainHorizontallyCenteredContainer className="md:mt-6">
      <div className="flex flex-col gap-6">
        <div>
          <Header2 spacing>General</Header2>
          <div className="w-full rounded-sm border border-grid-dimmed p-4">
            <Fieldset className="mb-5">
              <InputGroup fullWidth>
                <Label>Project ID</Label>
                <ClipboardField value={project.id} variant="secondary/medium" />
                <Hint>This UUID identifies the project in Platos APIs and audit records.</Hint>
              </InputGroup>
            </Fieldset>
            <Form method="post" {...renameForm.props}>
              <Fieldset>
                <InputGroup fullWidth>
                  <Label htmlFor={projectName.id}>Project name</Label>
                  <Input
                    {...conform.input(projectName, { type: "text" })}
                    defaultValue={project.name}
                    placeholder="Project name"
                    icon={FolderIcon}
                    autoFocus
                    onChange={(event) => setHasRenameFormChanges(event.target.value !== project.name)}
                  />
                  <FormError id={projectName.errorId}>{projectName.error}</FormError>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      name="action"
                      value="rename"
                      variant="secondary/small"
                      disabled={isRenameLoading || !hasRenameFormChanges}
                      LeadingIcon={isRenameLoading ? SpinnerWhite : undefined}
                    >
                      Save
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>
        </div>

        <div>
          <Header2 spacing>Danger zone</Header2>
          <div className="w-full rounded-sm border border-rose-500/40 p-4">
            <Form method="post" {...archiveForm.props}>
              <Fieldset>
                <InputGroup fullWidth>
                  <Label htmlFor={projectSlug.id}>Archive project</Label>
                  <Input
                    {...conform.input(projectSlug, { type: "text" })}
                    placeholder="Your project slug"
                    icon={ExclamationTriangleIcon}
                    onChange={(event) => setArchiveInputValue(event.target.value)}
                  />
                  <FormError id={projectSlug.errorId}>{projectSlug.error}</FormError>
                  <FormError>{archiveForm.error}</FormError>
                  <Hint>
                    Archiving removes this project and its environments from active navigation. Type
                    <InlineCode variant="extra-small">{project.slug}</InlineCode> to confirm.
                  </Hint>
                </InputGroup>
                <FormButtons
                  confirmButton={
                    <Button
                      type="submit"
                      name="action"
                      value="archive"
                      variant="danger/small"
                      LeadingIcon={isArchiveLoading ? SpinnerWhite : TrashIcon}
                      leadingIconClassName="text-white"
                      disabled={isArchiveLoading || archiveInputValue !== project.slug}
                    >
                      Archive
                    </Button>
                  }
                />
              </Fieldset>
            </Form>
          </div>
        </div>
      </div>
    </MainHorizontallyCenteredContainer>
  );
}
