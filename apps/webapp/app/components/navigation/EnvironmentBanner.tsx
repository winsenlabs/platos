import { ExclamationCircleIcon } from "@heroicons/react/20/solid";
import { AnimatePresence, motion } from "framer-motion";
import { useEnvironment, useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { Icon } from "../primitives/Icon";
import { Paragraph } from "../primitives/Paragraph";

export function EnvironmentBanner() {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();

  const isArchived = organization && project && environment && environment.archivedAt;

  return (
    <AnimatePresence initial={false}>
      {isArchived ? <ArchivedBranchBanner /> : null}
    </AnimatePresence>
  );
}

function ArchivedBranchBanner() {
  const environment = useEnvironment();

  return (
    <motion.div
      className="flex h-10 items-center justify-between overflow-hidden border-y border-amber-400/20 bg-warning/20 py-0 pl-3 pr-2"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "2.5rem" }}
      exit={{ opacity: 0, height: 0 }}
    >
      <div className="flex items-center gap-2">
        <Icon icon={ExclamationCircleIcon} className="h-5 w-5 text-amber-400" />
        <Paragraph variant="small" className="text-amber-200">
          "{environment.name}" is archived and read-only.
        </Paragraph>
      </div>
    </motion.div>
  );
}
