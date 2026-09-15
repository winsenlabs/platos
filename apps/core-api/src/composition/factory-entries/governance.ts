// WIN-302 — the contract factory of `governance`, named from `apps/core-api`
// through the `./application/index.js` entry point its manifest publishes.
//
// ONE MODULE PER CONTEXT, AND NOTHING ELSE IN IT, so a manifest that stops
// publishing the subpath fails the one case of `../context-factories.test.ts`
// that loads this module, instead of failing a whole suite at load. That file
// says why the import cannot sit in the suite itself.
export { createGovernanceContract } from "@platos/context-governance/application/index.js";
