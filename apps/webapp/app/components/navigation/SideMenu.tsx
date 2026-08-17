import {
  AdjustmentsHorizontalIcon,
  ArrowPathRoundedSquareIcon,
  ArrowRightOnRectangleIcon,
  ArrowTopRightOnSquareIcon,
  AcademicCapIcon,
  BeakerIcon,
  BookOpenIcon,
  BuildingOffice2Icon,
  ClipboardDocumentCheckIcon,
  CpuChipIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog8ToothIcon,
  CogIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeAmericasIcon,
  KeyIcon,
  LightBulbIcon,
  PencilSquareIcon,
  PlusIcon,
  PuzzlePieceIcon,
  RectangleStackIcon,
  ServerStackIcon,
  ShareIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
  TableCellsIcon,
  UsersIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/20/solid";
import { Link, useFetcher, useNavigation } from "@remix-run/react";
import { IconBugFilled } from "@tabler/icons-react";
import { LayoutGroup, motion } from "framer-motion";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTypedRouteLoaderData } from "remix-typedjson";
import simplur from "simplur";
import { AIMetricsIcon } from "~/assets/icons/AIMetricsIcon";
import { AIPromptsIcon } from "~/assets/icons/AIPromptsIcon";
import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { BranchEnvironmentIconSmall } from "~/assets/icons/EnvironmentIcons";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { LogsIcon } from "~/assets/icons/LogsIcon";
import { Avatar, defaultAvatar } from "~/components/primitives/Avatar";
import { type MatchedEnvironment } from "~/hooks/useEnvironment";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { type MatchedProject } from "~/hooks/useProject";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useHasAdminAccess } from "~/hooks/useUser";
import { type UserWithDashboardPreferences } from "~/models/user.server";
import { type loader as rootLoader } from "~/root";
import { IncidentStatusPanel, useIncidentStatus } from "~/routes/resources.incidents";
import { cn } from "~/utils/cn";
import {
  accountPath,
  adminPath,
  logoutPath,
  newOrganizationPath,
  newProjectPath,
  organizationPath,
  organizationSettingsPath,
  organizationTeamPath,
  v3ApiKeysPath,
  v3EnvironmentPath,
  v3ProjectPath,
  v3ProjectSettingsGeneralPath,
  v3ProjectSettingsIntegrationsPath,
  agentsPath,
  agentToolsPath,
  agentEntitiesPath,
  agentAccountsPath,
  agentMonitoringPath,
  agentFilesPath,
  agentMcpsPath,
  agentClustersPath,
  agentGovernancePath,
  approvalsPath,
  agentBudgetsPath,
  agentProvidersPath,
  agentConnectPath,
  agentEvalsPath,
  evalCriteriaPath,
  skillsPath,
  memoriesPath,
  platosTasksPath,
} from "~/utils/pathBuilder";
import { AlphaBadge } from "../AlphaBadge";
import { AskAI } from "../AskAI";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { Button, ButtonContent, LinkButton } from "../primitives/Buttons";
import { Paragraph } from "../primitives/Paragraph";
import { Popover, PopoverContent, PopoverMenuItem, PopoverTrigger } from "../primitives/Popover";
import { ShortcutKey } from "../primitives/ShortcutKey";
import { TextLink } from "../primitives/TextLink";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../primitives/Tooltip";
import { ShortcutsAutoOpen } from "../Shortcuts";
import { UserProfilePhoto } from "../UserProfilePhoto";
import { EnvironmentSelector } from "./EnvironmentSelector";
import { SideMenuHeader } from "./SideMenuHeader";
import { SideMenuItem } from "./SideMenuItem";
import { SideMenuSection } from "./SideMenuSection";
import { type SideMenuSectionId } from "./sideMenuTypes";

/** Get the collapsed state for a specific side menu section from user preferences */
function getSectionCollapsed(
  sideMenu: { collapsedSections?: Record<string, boolean> } | undefined,
  sectionId: SideMenuSectionId
): boolean {
  return sideMenu?.collapsedSections?.[sectionId] ?? false;
}

type SideMenuUser = Pick<
  UserWithDashboardPreferences,
  "email" | "platformOperator" | "dashboardPreferences"
> & {
  isImpersonating: boolean;
};
export type SideMenuProject = Pick<
  MatchedProject,
  "id" | "name" | "slug" | "environments" | "createdAt"
>;
export type SideMenuEnvironment = MatchedEnvironment;

type SideMenuProps = {
  user: SideMenuUser;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  button?: ReactNode;
};

export function SideMenu({
  user,
  project,
  environment,
  organization,
  organizations,
}: SideMenuProps) {
  const borderRef = useRef<HTMLDivElement>(null);
  const [showHeaderDivider, setShowHeaderDivider] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(
    user.dashboardPreferences.sideMenu?.isCollapsed ?? false
  );
  const preferencesFetcher = useFetcher();
  const pendingPreferencesRef = useRef<{
    isCollapsed?: boolean;
    sectionId?: SideMenuSectionId;
    sectionCollapsed?: boolean;
  }>({});
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isAdmin = useHasAdminAccess();
  const incidentStatus = useIncidentStatus();
  const externalTriggerDashboardUrl = useTypedRouteLoaderData<typeof rootLoader>("root")
    ?.externalTriggerDashboardUrl;
  const isV3Project = false;

  // Agents are now env-scoped — switching environment must refetch agent
  // lists. The env switcher renders on every agent page just like the rest
  // of the scoped routes.

  const persistSideMenuPreferences = useCallback(
    (data: {
      isCollapsed?: boolean;
      sectionId?: SideMenuSectionId;
      sectionCollapsed?: boolean;
    }) => {
      if (user.isImpersonating) return;

      // Merge with any pending changes
      pendingPreferencesRef.current = {
        ...pendingPreferencesRef.current,
        ...data,
      };

      // Clear existing timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Debounce the actual submission by 500ms
      debounceTimeoutRef.current = setTimeout(() => {
        const pending = pendingPreferencesRef.current;
        const formData = new FormData();
        if (pending.isCollapsed !== undefined) {
          formData.append("isCollapsed", String(pending.isCollapsed));
        }
        if (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined) {
          formData.append("sectionId", pending.sectionId);
          formData.append("sectionCollapsed", String(pending.sectionCollapsed));
        }
        preferencesFetcher.submit(formData, {
          method: "POST",
          action: "/resources/preferences/sidemenu",
        });
        pendingPreferencesRef.current = {};
      }, 500);
    },
    [user.isImpersonating, preferencesFetcher]
  );

  // Flush pending preferences on unmount to avoid losing the last toggle
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (user.isImpersonating) return;
      const pending = pendingPreferencesRef.current;
      const hasPendingChanges =
        pending.isCollapsed !== undefined ||
        (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined);

      if (hasPendingChanges) {
        const formData = new FormData();
        if (pending.isCollapsed !== undefined) {
          formData.append("isCollapsed", String(pending.isCollapsed));
        }
        if (pending.sectionId !== undefined && pending.sectionCollapsed !== undefined) {
          formData.append("sectionId", pending.sectionId);
          formData.append("sectionCollapsed", String(pending.sectionCollapsed));
        }
        preferencesFetcher.submit(formData, {
          method: "POST",
          action: "/resources/preferences/sidemenu",
        });
        pendingPreferencesRef.current = {};
      }
    };
  }, [preferencesFetcher, user.isImpersonating]);

  const handleToggleCollapsed = () => {
    const newIsCollapsed = !isCollapsed;
    setIsCollapsed(newIsCollapsed);
    persistSideMenuPreferences({ isCollapsed: newIsCollapsed });
  };

  /** Generic handler for any collapsible section - just pass the section ID */
  const handleSectionToggle = useCallback(
    (sectionId: SideMenuSectionId) => (collapsed: boolean) => {
      persistSideMenuPreferences({ sectionId, sectionCollapsed: collapsed });
    },
    [persistSideMenuPreferences]
  );

  useShortcutKeys({
    shortcut: { modifiers: ["mod"], key: "b", enabledOnInputElements: true },
    action: handleToggleCollapsed,
  });

  useEffect(() => {
    const handleScroll = () => {
      if (borderRef.current) {
        const shouldShowHeaderDivider = borderRef.current.scrollTop > 1;
        if (showHeaderDivider !== shouldShowHeaderDivider) {
          setShowHeaderDivider(shouldShowHeaderDivider);
        }
      }
    };

    borderRef.current?.addEventListener("scroll", handleScroll);
    return () => borderRef.current?.removeEventListener("scroll", handleScroll);
  }, [showHeaderDivider]);

  return (
    <div
      className={cn(
        "side-menu-responsive relative h-full border-r border-grid-bright bg-background-bright transition-all duration-200",
        isCollapsed ? "w-[2.75rem]" : "w-56"
      )}
    >
      <CollapseToggle isCollapsed={isCollapsed} onToggle={handleToggleCollapsed} />
      <div className="absolute inset-0 grid grid-cols-[100%] grid-rows-[2.5rem_1fr_auto] overflow-hidden">
        <div
          className={cn(
            "flex min-w-0 items-center overflow-hidden border-b px-1 py-1 transition duration-300",
            showHeaderDivider || isCollapsed ? "border-grid-bright" : "border-transparent"
          )}
        >
          <div className={cn("min-w-0", !isCollapsed && "flex-1")}>
            <ProjectSelector
              organizations={organizations}
              organization={organization}
              project={project}
              user={user}
              isCollapsed={isCollapsed}
            />
          </div>
          {isAdmin && !user.isImpersonating ? (
            <CollapsibleElement isCollapsed={isCollapsed}>
              <TooltipProvider disableHoverableContent={true}>
                <Tooltip>
                  <TooltipTrigger>
                    <LinkButton
                      variant="minimal/medium"
                      to={adminPath()}
                      TrailingIcon={UsersIcon}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className={"text-xs"}>
                    Admin dashboard
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </CollapsibleElement>
          ) : isAdmin && user.isImpersonating ? (
            <CollapsibleElement isCollapsed={isCollapsed}>
              <ImpersonationBanner />
            </CollapsibleElement>
          ) : null}
        </div>
        <div
          className={cn(
            "min-h-0 overflow-y-auto pt-2",
            isCollapsed
              ? "scrollbar-none"
              : "scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          )}
          ref={borderRef}
        >
          <div className="mb-6 flex w-full flex-col gap-4 overflow-hidden px-1">
            <div className="w-full space-y-1">
              <SideMenuHeader
                title={"Environment"}
                isCollapsed={isCollapsed}
                collapsedTitle="Env"
              />
              <div className="flex items-center">
                <EnvironmentSelector
                  organization={organization}
                  project={project}
                  environment={environment}
                  className="w-full"
                  isCollapsed={isCollapsed}
                />
              </div>
            </div>

            {/* ═══════════════════════════════════════════════
                AGENT PLATFORM — primary section, first in the sidebar.
                Agents are Platos's headline product; durable runs and tasks
                sit below as the platform engine.
                ═══════════════════════════════════════════════ */}
            <SideMenuSection
              title="Agent Platform"
              isSideMenuCollapsed={isCollapsed}
              itemSpacingClassName="space-y-0"
              initialCollapsed={getSectionCollapsed(user.dashboardPreferences.sideMenu, "agents")}
              onCollapseToggle={handleSectionToggle("agents")}
            >
              {/* PIFSP-2 — Plato Central overview replaces the env root landing. */}
              <SideMenuItem
                name="Plato Central"
                icon={Squares2X2Icon}
                activeIconColor="text-indigo-400"
                inactiveIconColor="text-indigo-400"
                to={v3EnvironmentPath(organization, project, environment)}
                data-action="overview"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Agents"
                icon={CpuChipIcon}
                activeIconColor="text-emerald-500"
                inactiveIconColor="text-emerald-500"
                to={agentsPath(organization, project, environment)}
                data-action="agents"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Tools"
                icon={WrenchScrewdriverIcon}
                activeIconColor="text-amber-500"
                inactiveIconColor="text-amber-500"
                to={agentToolsPath(organization, project, environment)}
                data-action="agent-tools"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="MCPs"
                icon={ShareIcon}
                activeIconColor="text-violet-400"
                inactiveIconColor="text-violet-400"
                to={agentMcpsPath(organization, project, environment)}
                data-action="agent-mcps"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Clusters"
                icon={ServerStackIcon}
                activeIconColor="text-violet-400"
                inactiveIconColor="text-violet-400"
                to={agentClustersPath(organization, project, environment)}
                data-action="agent-clusters"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Connected Entities"
                icon={BuildingOffice2Icon}
                activeIconColor="text-blue-500"
                inactiveIconColor="text-blue-500"
                to={agentEntitiesPath(organization, project, environment)}
                data-action="agent-entities"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Connected Accounts"
                icon={UsersIcon}
                activeIconColor="text-blue-400"
                inactiveIconColor="text-blue-400"
                to={agentAccountsPath(organization, project, environment)}
                data-action="agent-accounts"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Files"
                icon={FolderIcon}
                activeIconColor="text-sky-400"
                inactiveIconColor="text-sky-400"
                to={agentFilesPath(organization, project, environment)}
                data-action="agent-files"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Monitoring"
                icon={ShieldCheckIcon}
                activeIconColor="text-rose-500"
                inactiveIconColor="text-rose-500"
                to={agentMonitoringPath(organization, project, environment)}
                data-action="agent-monitoring"
                isCollapsed={isCollapsed}
              />
              <ApprovalsSideMenuItem
                organization={organization}
                project={project}
                environment={environment}
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Governance"
                icon={ShieldCheckIcon}
                activeIconColor="text-emerald-500"
                inactiveIconColor="text-emerald-500"
                to={agentGovernancePath(organization, project, environment)}
                data-action="agent-governance"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Budget caps"
                icon={ShieldCheckIcon}
                activeIconColor="text-amber-500"
                inactiveIconColor="text-amber-500"
                to={agentBudgetsPath(organization, project, environment)}
                data-action="agent-budgets"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Providers"
                icon={KeyIcon}
                activeIconColor="text-yellow-500"
                inactiveIconColor="text-yellow-500"
                to={agentProvidersPath(organization, project, environment)}
                data-action="agent-providers"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Skills"
                icon={BookOpenIcon}
                activeIconColor="text-purple-500"
                inactiveIconColor="text-purple-500"
                to={skillsPath(organization, project, environment)}
                data-action="skills"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Memories"
                icon={LightBulbIcon}
                activeIconColor="text-amber-400"
                inactiveIconColor="text-amber-400"
                to={memoriesPath(organization, project, environment)}
                data-action="memories"
                isCollapsed={isCollapsed}
              />
              {/* EOBD.76 — surface Evals + Eval Criteria (Theme J) in the
                  Agent Platform nav. A/B testing is per-agent (lives at
                  /agents/:id/evals-ab); link from agent detail PageAccessories
                  instead of a top-level sidebar entry. Prompts + Models live
                  under the AI section below and are already wired. */}
              <SideMenuItem
                name="Evals"
                icon={AcademicCapIcon}
                activeIconColor="text-pink-500"
                inactiveIconColor="text-pink-500"
                to={agentEvalsPath(organization, project, environment)}
                data-action="agent-evals"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Eval criteria"
                icon={ClipboardDocumentCheckIcon}
                activeIconColor="text-pink-400"
                inactiveIconColor="text-pink-400"
                to={evalCriteriaPath(organization, project, environment)}
                data-action="eval-criteria"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Connect"
                icon={GlobeAmericasIcon}
                activeIconColor="text-cyan-500"
                inactiveIconColor="text-cyan-500"
                to={agentConnectPath(organization, project, environment)}
                data-action="agent-connect"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="API keys"
                icon={KeyIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ApiKeysPath(organization, project, environment)}
                data-action="api keys"
                isCollapsed={isCollapsed}
              />
            </SideMenuSection>

            {/* Platos — operator-authored tasks. */}
            <SideMenuSection
              title="Tasks"
              isSideMenuCollapsed={isCollapsed}
              itemSpacingClassName="space-y-0"
              initialCollapsed={getSectionCollapsed(user.dashboardPreferences.sideMenu, "tasks")}
              onCollapseToggle={handleSectionToggle("tasks")}
            >
              {/* PIFSP-12 — operator-authored custom tasks. */}
              <SideMenuItem
                name="Custom Tasks"
                icon={WrenchScrewdriverIcon}
                activeIconColor="text-emerald-400"
                inactiveIconColor="text-emerald-400"
                to={platosTasksPath(organization, project, environment)}
                data-action="platos-tasks"
                isCollapsed={isCollapsed}
              />
              {externalTriggerDashboardUrl ? (
                <SideMenuItem
                  name="External Trigger"
                  icon={ArrowTopRightOnSquareIcon}
                  trailingIcon={ArrowTopRightOnSquareIcon}
                  activeIconColor="text-blue-400"
                  inactiveIconColor="text-blue-400"
                  to={externalTriggerDashboardUrl}
                  target="_blank"
                  data-action="external-trigger"
                  isCollapsed={isCollapsed}
                />
              ) : null}
              {/* Platos-only: trigger Runs/Batches/Schedules/Queues/Waitpoint tokens/Deployments/Test stripped from the nav. */}
            </SideMenuSection>

            {/* Platos-only: trigger AI (Prompts/Models/AI Metrics), Observability (Logs/Errors/Query/Dashboards), and Manage (Bulk actions/API keys/Env vars/Alerts/Regions/Limits) nav sections stripped. */}

            <SideMenuSection
              title="Project settings"
              isSideMenuCollapsed={isCollapsed}
              itemSpacingClassName="space-y-0"
              initialCollapsed={getSectionCollapsed(
                user.dashboardPreferences.sideMenu,
                "project-settings"
              )}
              onCollapseToggle={handleSectionToggle("project-settings")}
            >
              <SideMenuItem
                name="General"
                icon={Cog8ToothIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ProjectSettingsGeneralPath(organization, project, environment)}
                data-action="project-settings-general"
                isCollapsed={isCollapsed}
              />
              <SideMenuItem
                name="Integrations"
                icon={PuzzlePieceIcon}
                activeIconColor="text-text-bright"
                inactiveIconColor="text-text-dimmed"
                to={v3ProjectSettingsIntegrationsPath(organization, project, environment)}
                data-action="project-settings-integrations"
                isCollapsed={isCollapsed}
              />
            </SideMenuSection>
          </div>
        </div>
        <div>
          <IncidentStatusPanel
            isCollapsed={isCollapsed}
            title={incidentStatus.title}
            hasIncident={incidentStatus.hasIncident}
            isManagedCloud={incidentStatus.isManagedCloud}
          />
          <V3DeprecationPanel
            isCollapsed={isCollapsed}
            isV3={isV3Project}
            projectCreatedAt={project.createdAt}
            hasIncident={incidentStatus.hasIncident}
            isManagedCloud={incidentStatus.isManagedCloud}
          />
          <motion.div
            layout
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className={cn(
              "flex flex-col gap-1 border-t border-grid-bright p-1",
              isCollapsed && "items-center"
            )}
          >
            <HelpAndAI isCollapsed={isCollapsed} />
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function V3DeprecationPanel({
  isCollapsed,
  isV3,
  projectCreatedAt,
  hasIncident,
  isManagedCloud,
}: {
  isCollapsed: boolean;
  isV3: boolean;
  projectCreatedAt: Date;
  hasIncident: boolean;
  isManagedCloud: boolean;
}) {
  // Only show for projects created before v4 was released
  const V4_RELEASE_DATE = new Date("2025-09-01");
  const isLikelyV3 = isV3 && new Date(projectCreatedAt) < V4_RELEASE_DATE;

  if (!isManagedCloud || !isLikelyV3 || hasIncident) {
    return null;
  }

  return (
    <Popover>
      <div className="p-1">
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? 0 : "auto",
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <V3DeprecationContent />
        </motion.div>

        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? "auto" : 0,
            opacity: isCollapsed ? 1 : 0,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <SimpleTooltip
            button={
              <PopoverTrigger className="flex !h-8 w-full items-center justify-center rounded border border-amber-500/30 bg-amber-500/15 transition-colors hover:border-amber-500/50 hover:bg-amber-500/25">
                <ExclamationTriangleIcon className="size-5 text-amber-400" />
              </PopoverTrigger>
            }
            content="V3 deprecation warning"
            side="right"
            sideOffset={8}
            disableHoverableContent
            asChild
          />
        </motion.div>
      </div>
      <PopoverContent side="right" sideOffset={8} align="start" className="w-52 !min-w-0 p-0">
        <V3DeprecationContent />
      </PopoverContent>
    </Popover>
  );
}

function V3DeprecationContent() {
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 pt-1.5">
      <div className="flex items-center gap-1 border-b border-amber-500/30 pb-1">
        <ExclamationTriangleIcon className="size-4 text-amber-400" />
        <Paragraph variant="small/bright" className="text-amber-300">
          V3 deprecation warning
        </Paragraph>
      </div>
      <Paragraph variant="extra-small/bright" className="text-amber-300">
        This is a v3 project. V3 deploys will stop working on 1 April 2026. Full shutdown is 1 July
        2026 where all v3 runs will stop executing. Migrate to v4 to avoid downtime.
      </Paragraph>
      {/* TODO(Theme-P): no dedicated v3 migration slug yet on platos.dev/docs.
          Pointing at the docs index until a migration page lands. */}
      <LinkButton
        variant="secondary/small"
        to="https://platos.dev/docs"
        target="_blank"
        fullWidth
        TrailingIcon={ArrowTopRightOnSquareIcon}
        trailingIconClassName="text-amber-300"
        className="border-amber-500/30 bg-amber-500/15 hover:!border-amber-500/50 hover:!bg-amber-500/25"
      >
        <span className="text-amber-300">View migration guide</span>
      </LinkButton>
    </div>
  );
}

function ProjectSelector({
  project,
  organization,
  organizations,
  user,
  isCollapsed = false,
}: {
  project: SideMenuProject;
  organization: MatchedOrganization;
  organizations: MatchedOrganization[];
  user: SideMenuUser;
  isCollapsed?: boolean;
}) {
  const [isOrgMenuOpen, setOrgMenuOpen] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    setOrgMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setOrgMenuOpen(open)} open={isOrgMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded pl-[0.4375rem] transition-colors hover:bg-charcoal-750",
              isCollapsed ? "justify-center pr-0.5" : "w-full justify-between pr-1"
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <Avatar avatar={defaultAvatar} size={1.25} orgName={organization.name} />
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 overflow-hidden transition-all duration-200",
                  isCollapsed ? "max-w-0 opacity-0" : "max-w-[200px] opacity-100"
                )}
              >
                <SelectorDivider />
                <span className="truncate text-2sm font-normal text-text-bright">
                  {project.name ?? "Select a project"}
                </span>
              </span>
            </span>
            <span
              className={cn(
                "overflow-hidden transition-all duration-200",
                isCollapsed ? "max-w-0 opacity-0" : "max-w-[16px] opacity-100"
              )}
            >
              <DropdownIcon className="size-4 min-w-4 text-text-dimmed transition group-hover:text-text-bright" />
            </span>
          </PopoverTrigger>
        }
        content={`${organization.name} / ${project.name ?? "Select a project"}`}
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        buttonClassName="!h-8"
        asChild
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        side={isCollapsed ? "right" : "bottom"}
        sideOffset={isCollapsed ? 8 : 4}
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <div className="flex flex-col gap-2 bg-charcoal-750 p-2">
          <div className="flex items-center gap-2.5">
            <Link
              to={organizationSettingsPath(organization)}
              className="group relative box-content size-10 overflow-clip rounded-sm bg-charcoal-800"
            >
              <Avatar avatar={defaultAvatar} size={2.5} orgName={organization.name} />
              <div className="absolute inset-0 z-10 grid h-full w-full place-items-center bg-black/50 opacity-0 transition group-hover:opacity-100">
                <PencilSquareIcon className="size-5 text-text-bright" />
              </div>
            </Link>
            <div className="space-y-0.5">
              <Paragraph variant="small/bright">{organization.name}</Paragraph>
              <div className="flex items-baseline gap-2">
                <TextLink
                  variant="secondary"
                  className="text-xs"
                  to={organizationTeamPath(organization)}
                >{simplur`${organization.membersCount} member[|s]`}</TextLink>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LinkButton
              variant="secondary/small"
              to={organizationSettingsPath(organization)}
              fullWidth
              iconSpacing="gap-1.5"
              className="group-hover/button:border-charcoal-500"
            >
              <CogIcon className="size-4 text-text-dimmed" />
              <span className="text-text-bright">Settings</span>
            </LinkButton>
          </div>
        </div>
        <div className="flex flex-col gap-1 p-1">
          {organization.projects.map((p) => {
            const isSelected = p.id === project.id;
            return (
              <PopoverMenuItem
                key={p.id}
                to={v3ProjectPath(organization, p)}
                title={
                  <div className="flex w-full items-center justify-between text-text-bright">
                    <span className="grow truncate text-left">{p.name}</span>
                  </div>
                }
                isSelected={isSelected}
                icon={isSelected ? FolderOpenIcon : FolderIcon}
                leadingIconClassName="text-indigo-500"
              />
            );
          })}
          <PopoverMenuItem to={newProjectPath(organization)} title="New project" icon={PlusIcon} />
        </div>
        <div className="border-t border-charcoal-700 p-1">
          {organizations.length > 1 ? (
            <SwitchOrganizations organizations={organizations} organization={organization} />
          ) : (
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New organization"
              icon={PlusIcon}
              leadingIconClassName="text-text-dimmed"
            />
          )}
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem
            to={accountPath()}
            title="Account"
            icon={UserProfilePhoto}
            leadingIconClassName="text-text-dimmed rounded-full border border-transparent"
          />
        </div>
        <div className="border-t border-charcoal-700 p-1">
          <PopoverMenuItem
            to={logoutPath()}
            title="Logout"
            icon={ArrowRightOnRectangleIcon}
            leadingIconClassName="text-text-dimmed"
            danger
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SwitchOrganizations({
  organizations,
  organization,
}: {
  organizations: MatchedOrganization[];
  organization: MatchedOrganization;
}) {
  const navigation = useNavigation();
  const [isMenuOpen, setMenuOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [navigation.location?.pathname]);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setMenuOpen(true);
  };

  const handleMouseLeave = () => {
    // Small delay before closing to allow moving to the content
    timeoutRef.current = setTimeout(() => {
      setMenuOpen(false);
    }, 150);
  };

  return (
    <Popover onOpenChange={(open) => setMenuOpen(open)} open={isMenuOpen}>
      <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="flex">
        <PopoverTrigger className="w-full justify-between overflow-hidden focus-custom">
          <ButtonContent
            variant="small-menu-item"
            className="hover:bg-charcoal-750"
            LeadingIcon={ArrowPathRoundedSquareIcon}
            leadingIconClassName="text-text-dimmed"
            TrailingIcon={ChevronRightIcon}
            trailingIconClassName="text-text-dimmed"
            textAlignLeft
            fullWidth
          >
            Switch organization
          </ButtonContent>
        </PopoverTrigger>
        <PopoverContent
          className="min-w-[16rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
          align="start"
          style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
          side="right"
          alignOffset={0}
          sideOffset={-4}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="flex flex-col gap-1 p-1">
            {organizations.map((org) => (
              <PopoverMenuItem
                key={org.id}
                to={organizationPath(org)}
                title={org.name}
                icon={<Avatar size={1} avatar={defaultAvatar} orgName={org.name} />}
                leadingIconClassName="text-text-dimmed"
                isSelected={org.id === organization.id}
              />
            ))}
          </div>
          <div className="border-t border-charcoal-700 p-1">
            <PopoverMenuItem
              to={newOrganizationPath()}
              title="New organization"
              icon={PlusIcon}
              leadingIconClassName="text-text-dimmed"
            />
          </div>
        </PopoverContent>
      </div>
    </Popover>
  );
}

function SelectorDivider() {
  return (
    <svg width="6" height="21" viewBox="0 0 6 21" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line
        x1="5.3638"
        y1="0.606339"
        x2="0.606339"
        y2="19.6362"
        stroke="#3B3E45"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Helper component that fades out but preserves width (collapses to 0 width) */
function CollapsibleElement({
  isCollapsed,
  children,
  className,
}: {
  isCollapsed: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden transition-all duration-200",
        isCollapsed ? "max-w-0 opacity-0" : "max-w-[100px] opacity-100",
        className
      )}
    >
      {children}
    </div>
  );
}

function HelpAndAI({ isCollapsed }: { isCollapsed: boolean }) {
  // OSS launch: Help & Feedback popover removed (linked to internal Discord/email
  // channels that don't apply to self-hosters). AskAI retained because it's a
  // first-class agent runtime feature, not a support channel.
  return (
    <LayoutGroup>
      <div
        className={cn(
          "flex w-full",
          isCollapsed ? "flex-col-reverse gap-1" : "items-center justify-end"
        )}
      >
        <ShortcutsAutoOpen />
        <AskAI isCollapsed={isCollapsed} />
      </div>
    </LayoutGroup>
  );
}

function AnimatedChevron({
  isHovering,
  isCollapsed,
}: {
  isHovering: boolean;
  isCollapsed: boolean;
}) {
  // When hovering and expanded: left chevron (pointing left to collapse)
  // When hovering and collapsed: right chevron (pointing right to expand)
  // When not hovering: straight vertical line

  const getRotation = () => {
    if (!isHovering) return { top: 0, bottom: 0 };
    if (isCollapsed) {
      // Right chevron
      return { top: -17, bottom: 17 };
    } else {
      // Left chevron
      return { top: 17, bottom: -17 };
    }
  };

  const { top, bottom } = getRotation();

  // Calculate horizontal offset to keep chevron centered when rotated
  // Left chevron: translate left (-1.5px)
  // Right chevron: translate right (+1.5px)
  const getTranslateX = () => {
    if (!isHovering) return 0;
    return isCollapsed ? 1.5 : -1.5;
  };

  return (
    <motion.svg
      width="4"
      height="30"
      viewBox="0 0 4 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="pointer-events-none relative z-10 overflow-visible text-charcoal-600 transition-colors group-hover:text-text-bright"
      initial={false}
      animate={{
        x: getTranslateX(),
      }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* Top segment */}
      <motion.line
        x1="2"
        y1="1.5"
        x2="2"
        y2="15"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        initial={false}
        animate={{
          rotate: top,
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={{ transformOrigin: "2px 15px" }}
      />
      {/* Bottom segment */}
      <motion.line
        x1="2"
        y1="15"
        x2="2"
        y2="28.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        initial={false}
        animate={{
          rotate: bottom,
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={{ transformOrigin: "2px 15px" }}
      />
    </motion.svg>
  );
}

function CollapseToggle({ isCollapsed, onToggle }: { isCollapsed: boolean; onToggle: () => void }) {
  const [isHovering, setIsHovering] = useState(false);

  return (
    <div className="absolute -right-3 top-1/2 z-10 -translate-y-1/2">
      {/* Vertical line to mask the side menu border */}
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 h-10 w-px -translate-y-1/2 transition-colors duration-200",
          isHovering ? "bg-charcoal-750" : "bg-background-bright"
        )}
      />
      <TooltipProvider disableHoverableContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={isCollapsed ? "Expand side menu" : "Collapse side menu"}
              onClick={onToggle}
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={() => setIsHovering(false)}
              className={cn(
                "group flex h-12 w-6 items-center justify-center rounded-md text-text-dimmed transition-all duration-200 focus-custom",
                isHovering
                  ? "border border-grid-bright bg-background-bright shadow-md hover:bg-charcoal-750 hover:text-text-bright"
                  : "border border-transparent bg-transparent"
              )}
            >
              <AnimatedChevron isHovering={isHovering} isCollapsed={isCollapsed} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="flex items-center gap-2 text-xs">
            {isCollapsed ? "Expand" : "Collapse"}
            <span className="flex items-center">
              <ShortcutKey shortcut={{ modifiers: ["mod"] }} variant="medium/bright" />
              <ShortcutKey shortcut={{ key: "b" }} variant="medium/bright" />
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

/**
 * MCP approval-UI — sidebar entry with a live pending-count badge.
 *
 * Polls the `monitoring/approvals?status=pending&limit=1` endpoint
 * every 30s via the existing `/resources/agent` proxy. The result
 * payload's `pendingCount` is the scope-wide pending total (not
 * limited by the `limit=1` query, which only narrows the row list).
 *
 * Toast-on-rise: when `pendingCount` increases vs. the previous tick
 * we surface a tiny rose-tinted notification badge — the user already
 * sees the pulsing badge on the sidebar item itself, but the toast
 * cue is what catches attention if the sidebar is collapsed.
 */
function ApprovalsSideMenuItem({
  organization,
  project,
  environment,
  isCollapsed,
}: {
  organization: MatchedOrganization;
  project: SideMenuProject;
  environment: MatchedEnvironment;
  isCollapsed: boolean;
}) {
  const fetcher = useFetcher<{ pendingCount?: number }>();
  const [count, setCount] = useState<number | null>(null);
  const previousCount = useRef<number | null>(null);
  const [pulse, setPulse] = useState(false);

  // Build the proxy URL once per scope change.
  const proxyHref = `/resources/agent?path=${encodeURIComponent(
    "/api/v1/agent/monitoring/approvals?status=pending&limit=1"
  )}&organizationId=${encodeURIComponent(organization.id)}&projectId=${encodeURIComponent(
    project.id
  )}&environmentId=${encodeURIComponent(environment.id)}`;

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (fetcher.state !== "idle") return;
      fetcher.load(proxyHref);
    };
    // Initial fetch + 30s poll. The agent endpoint sweeps expired rows
    // before counting, so the badge auto-decrements when SLA windows
    // lapse without a new resolve.
    tick();
    const interval = setInterval(tick, 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyHref]);

  useEffect(() => {
    const incoming = fetcher.data?.pendingCount;
    if (typeof incoming !== "number") return;
    if (previousCount.current !== null && incoming > previousCount.current) {
      // Briefly pulse the badge so a rising count is visually obvious
      // even when the user isn't looking at the sidebar.
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 4000);
      return () => clearTimeout(timer);
    }
    previousCount.current = incoming;
    setCount(incoming);
    return () => {};
  }, [fetcher.data]);

  const showBadge = typeof count === "number" && count > 0;
  const badge = showBadge ? (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none transition-colors",
        pulse
          ? "bg-rose-500 text-white animate-pulse"
          : "bg-rose-500/20 text-rose-300"
      )}
      title={`${count} pending approval${count === 1 ? "" : "s"}`}
    >
      {count}
    </span>
  ) : null;

  return (
    <SideMenuItem
      name="Approvals"
      icon={ShieldCheckIcon}
      activeIconColor="text-amber-400"
      inactiveIconColor="text-amber-400"
      to={approvalsPath(organization, project, environment)}
      data-action="approvals"
      isCollapsed={isCollapsed}
      badge={badge}
    />
  );
}
