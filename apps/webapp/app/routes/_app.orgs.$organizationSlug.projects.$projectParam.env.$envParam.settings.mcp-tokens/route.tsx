/**
 * Back-compat 307 redirect — this route moved to
 * `/settings/integrations/mcp` (Theme K.7 UX pass). Holding the old
 * path as a redirect so any bookmarked URLs keep working through the
 * first few releases; safe to remove once consumer docs are refreshed.
 */

import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  EnvironmentParamSchema,
  v3ProjectSettingsIntegrationsMcpPath,
} from "~/utils/pathBuilder";

export async function loader({ params }: LoaderFunctionArgs) {
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  return redirect(
    v3ProjectSettingsIntegrationsMcpPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
    ),
    { status: 307 },
  );
}
