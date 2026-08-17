import { DropdownIcon } from "~/assets/icons/DropdownIcon";
import { useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { useEnvironmentSwitcher } from "~/hooks/useEnvironmentSwitcher";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { cn } from "~/utils/cn";
import { EnvironmentCombo, EnvironmentIcon, EnvironmentLabel, environmentFullTitle } from "../environments/EnvironmentLabel";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "../primitives/Popover";
import { SimpleTooltip } from "../primitives/Tooltip";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";

export function EnvironmentSelector({
  organization,
  project,
  environment,
  className,
  isCollapsed = false,
}: {
  organization: MatchedOrganization;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  className?: string;
  isCollapsed?: boolean;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigation = useNavigation();
  const { urlForEnvironment } = useEnvironmentSwitcher();

  useEffect(() => {
    setIsMenuOpen(false);
  }, [navigation.location?.pathname]);

  return (
    <Popover onOpenChange={(open) => setIsMenuOpen(open)} open={isMenuOpen}>
      <SimpleTooltip
        button={
          <PopoverTrigger
            className={cn(
              "group flex h-8 items-center rounded pl-[0.4375rem] transition-colors hover:bg-charcoal-750",
              isCollapsed ? "justify-center pr-0.5" : "justify-between pr-1",
              className
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <EnvironmentIcon environment={environment} className="size-5 shrink-0" />
              <span
                className={cn(
                  "flex min-w-0 items-center overflow-hidden transition-all duration-200",
                  isCollapsed ? "max-w-0 opacity-0" : "max-w-[200px] opacity-100"
                )}
              >
                <EnvironmentLabel environment={environment} className="text-2sm" disableTooltip />
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
        content={environmentFullTitle(environment)}
        side="right"
        sideOffset={8}
        hidden={!isCollapsed}
        buttonClassName="!h-8"
        asChild
        disableHoverableContent
      />
      <PopoverContent
        className="min-w-[14rem] overflow-y-auto p-0 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        side={isCollapsed ? "right" : "bottom"}
        sideOffset={isCollapsed ? 8 : 4}
        align="start"
        style={{ maxHeight: `calc(var(--radix-popover-content-available-height) - 10vh)` }}
      >
        <div className="flex flex-col gap-1 p-1">
          {project.environments.map((env) => (
            <PopoverMenuItem
              key={env.id}
              to={urlForEnvironment(env)}
              title={<EnvironmentCombo environment={env} className="mx-auto grow text-2sm" />}
              isSelected={env.id === environment.id}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
