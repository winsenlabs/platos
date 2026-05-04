import { motion } from "framer-motion";
import { LogoIcon } from "./LogoIcon";

// Theme BR (follow-up) — replaces the Trigger.dev Spline rotating logo on
// the 404 / error page. Uses the existing `LogoIcon` mark (served from
// `/images/platos-icon.ico`) so favicon + error page stay 1:1. A gentle
// framer-motion fade + slow spin keeps the "something is alive" vibe
// without pulling in the external Spline viewer CDN.
export function PlatosErrorLogo() {
  return (
    <motion.div
      className="pointer-events-none absolute inset-0 flex items-end justify-center overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.12 }}
      transition={{ delay: 0.5, duration: 2, ease: "easeOut" }}
      aria-hidden
    >
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 60, ease: "linear", repeat: Infinity }}
        className="mb-[-10vh]"
      >
        <LogoIcon className="h-[60vh] w-[60vh]" />
      </motion.div>
    </motion.div>
  );
}
