import { BookOpenIcon } from "@heroicons/react/20/solid";
import { LinkButton } from "./Buttons";

/**
 * A small "Docs" affordance that links to the corresponding section of
 * https://platos.dev/docs/<slug> or https://platos.dev/guides/<slug>.
 *
 * Renders as a quiet `docs/small` chip — designed to live inside a
 * `<PageAccessories>` block next to a page H1. Use sparingly: one per
 * meaningful dashboard page. Don't link to a slug that doesn't exist —
 * leave the chip off rather than send users to a 404.
 *
 * The base URL is the production marketing site (platos.dev), NOT
 * `test.platos.dev`. Self-hosters can't redirect this without forking;
 * the docs are public reference material regardless of where the
 * dashboard runs.
 */
export type DocsLinkProps = {
  /** Slug under /docs/ or /guides/ — without leading slash, without `.md`. */
  slug: string;
  /** Which top-level section. Defaults to "docs". */
  kind?: "docs" | "guides";
  /** Override label. Defaults to "Docs" (or "Guide" for kind="guides"). */
  label?: string;
  /** Optional className passthrough. */
  className?: string;
};

export function DocsLink({ slug, kind = "docs", label, className }: DocsLinkProps) {
  const href = `https://platos.dev/${kind}/${slug}`;
  const resolvedLabel = label ?? (kind === "guides" ? "Guide" : "Docs");

  return (
    <LinkButton
      to={href}
      variant="docs/small"
      LeadingIcon={BookOpenIcon}
      className={className}
    >
      {resolvedLabel}
    </LinkButton>
  );
}
