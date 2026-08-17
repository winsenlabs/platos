import { type Path, useMatches } from "@remix-run/react";
import { useOptimisticLocation } from "./useOptimisticLocation";

/**
 * It gives the URLs for the current page for other environments
 * @returns
 */
export function useEnvironmentSwitcher() {
  const matches = useMatches();
  const location = useOptimisticLocation();

  const urlForEnvironment = (newEnvironment: { id: string }) => {
    return routeForEnvironmentSwitch({
      location,
      matchId: matches[matches.length - 1].id,
      environmentId: newEnvironment.id,
    });
  };

  return {
    urlForEnvironment,
  };
}

/** Function that takes in a UIMatch id, the current URL, the new environment slug, and returns a new URL  */
export function routeForEnvironmentSwitch({
  location,
  matchId,
  environmentId,
}: {
  location: Path;
  matchId: string;
  environmentId: string;
}) {
  switch (matchId) {
    // Run page
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam": {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentId).replace(
          /\/runs\/.*/,
          "/runs"
        ),
        search: "",
        hash: "",
      };
      return fullPath(newLocation);
    }
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments.$deploymentParam": {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentId).replace(
          /\/deployments\/.*/,
          "/deployments"
        ),
        search: "",
        hash: "",
      };
      return fullPath(newLocation);
    }
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam":
    case "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.edit.$scheduleParam": {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentId).replace(
          /\/schedules\/.*/,
          "/schedules"
        ),
        search: "",
        hash: "",
      };
      return fullPath(newLocation);
    }
    default: {
      const newLocation: Path = {
        pathname: replaceEnvInPath(location.pathname, environmentId),
        search: location.search,
        hash: location.hash,
      };
      return fullPath(newLocation);
    }
  }
}

/**
 * Replace the /env/<id>/ segment with a canonical UUID Environment id.
 */
function replaceEnvInPath(path: string, environmentId: string) {
  //allow anything except /
  return path.replace(/env\/([^/]+)/, `env/${environmentId}`);
}

function fullPath(location: Path) {
  return `${location.pathname}${location.search}${location.hash}`;
}
