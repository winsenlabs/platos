// Theme BR — Platos landscape wordmark. Served as a PNG from
// `/images/platos-logotype.png`; existing `className` consumer shape
// preserved so every sidebar / login / email / footer call-site
// keeps working unchanged.
export function LogoType({ className }: { className?: string }) {
  return (
    <img
      src="/images/platos-logotype.png"
      alt="Platos"
      className={className}
      draggable={false}
    />
  );
}
