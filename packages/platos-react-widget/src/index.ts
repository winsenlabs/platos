/**
 * @platosdev/react-widget — public exports.
 *
 * Default usage (drop-in chat bubble):
 *
 *     import "@platosdev/react-widget/styles.css";
 *     import { PlatosFab } from "@platosdev/react-widget";
 *
 *     <PlatosFab
 *       baseUrl="https://platos.example.com"
 *       agentId="agt_xxx"
 *       tokenUrl="/api/platos-session"
 *     />
 *
 * Headless usage (build your own UI):
 *
 *     import { usePlatosChat } from "@platosdev/react-widget";
 *     const { messages, send, status } = usePlatosChat({ ... });
 */

export { PlatosFab } from "./PlatosFab.js";
export { IdentityForm } from "./IdentityForm.js";
export {
  usePlatosChat,
  type ChatMessage,
  type ChatStatus,
  type UsePlatosChatArgs,
  type UsePlatosChatResult,
} from "./usePlatosChat.js";
export type {
  ClassNames,
  IdentityMode,
  OtpEndpoints,
  PerTurnOptions,
  PlatosFabProps,
  Position,
  ThemeTokens,
  VisitorIdentity,
} from "./types.js";
