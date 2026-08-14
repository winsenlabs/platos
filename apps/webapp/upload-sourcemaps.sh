#!/bin/bash
set -eo pipefail

if [ "$WEBAPP_BUILD_SOURCEMAPS" = "true" ] && [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ] && [ -n "$SENTRY_AUTH_TOKEN" ] && [ -n "$SENTRY_RELEASE" ]; then
  sentry-cli releases new $SENTRY_RELEASE
  sentry-cli sourcemaps inject ./build
  sentry-cli sourcemaps upload ./build --release $SENTRY_RELEASE
  # Now we need to delete the sourcemaps from the build directory
  rm -rf ./build/*.map
else
  echo "Skipping sourcemap upload: WEBAPP_BUILD_SOURCEMAPS is not true or Sentry configuration is incomplete"
  echo "Required: WEBAPP_BUILD_SOURCEMAPS=true, SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN, SENTRY_RELEASE"
  # Never ship server-side source maps in the runtime image when upload is off.
  find ./build -type f -name '*.map' -delete
fi
