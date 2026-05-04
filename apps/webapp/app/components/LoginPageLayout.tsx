import { LogoType } from "./LogoType";
import { LinkButton } from "./primitives/Buttons";
import { Paragraph } from "./primitives/Paragraph";
import { TextLink } from "./primitives/TextLink";
import { BookOpenIcon } from "@heroicons/react/20/solid";

export function LoginPageLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid h-full grid-cols-1 lg:grid-cols-2">
      <div className="bg-background-dimmed lg:border-r lg:border-grid-bright lg:bg-background-bright">
        <div className="flex h-full flex-col items-center justify-center p-6 lg:justify-between">
          <div className="hidden w-full items-center justify-between lg:flex">
            {/* TODO(Theme-P): point to docs.platos.dev once the docs site ships */}
            <a href="https://github.com/platos-dev/platos">
              <LogoType className="w-36" />
            </a>
            <LinkButton
              // TODO(Theme-P): swap for docs.platos.dev when it ships
              to="https://github.com/platos-dev/platos#docs"
              variant={"tertiary/small"}
              LeadingIcon={BookOpenIcon}
            >
              Documentation
            </LinkButton>
          </div>
          <div className="flex h-full max-w-sm items-center justify-center">{children}</div>
          <Paragraph variant="small" className="text-center">
            {/* TODO(Theme-BR-community): swap for a Platos community channel once it exists */}
            Having login issues?{" "}
            <TextLink href="https://github.com/platos-dev/platos/issues">
              Open a GitHub issue
            </TextLink>
          </Paragraph>
        </div>
      </div>
      <div className="hidden grid-rows-[1fr_auto] pb-6 lg:grid">
        <div className="flex h-full flex-col items-center justify-center px-16">
          <h2 className="text-center text-3xl font-semibold leading-tight text-text-bright lg-height:text-2xl md-height:text-xl">
            The only agent runtime you will need.
          </h2>
          <Paragraph className="mt-4 max-w-md text-center text-text-dimmed">
            Everything you need to deploy, monitor, and manage agents in production. Go live in minutes, not months.
          </Paragraph>
        </div>
      </div>
    </main>
  );
}
