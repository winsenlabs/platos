// Theme BR — Platos square icon-mark. Renders the SVG variant served from
// `/images/platos-icon.svg` so the mark stays sharp at every size (sidebar
// 24px, login 64px, error page 60vh). The matching `.ico` is still served
// as the browser favicon via `public/favicon.ico`. `className` consumer
// shape preserved.
export function LogoIcon({ className }: { className?: string }) {
  return (
    <img
      src="/images/platos-icon.svg"
      alt="Platos"
      className={className}
      draggable={false}
    />
  );
}
