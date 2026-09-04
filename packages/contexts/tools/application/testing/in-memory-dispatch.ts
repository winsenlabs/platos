// An in-memory `ToolDispatch`.
//
// IT RECORDS WHAT WENT UPSTREAM, WHICH IS THE POINT. The invariant this context
// cannot get wrong is that a refused call sends ZERO BYTES to a backend, and
// the only way to test that is to have a backend that remembers. `requests` is
// therefore the assertion surface: a test that expects a refusal asserts the
// array is EMPTY, not merely that the result was an error.
//
// IT ALSO REFUSES A TARGET CARRYING AN UNSUBSTITUTED TEMPLATE. That is the
// residual scan's job and `resolve-transport.ts` runs it before this is
// reached — so a double that accepted one would let a regression in the
// resolver pass every test in this package. Here it fails loudly, in the one
// place that stands for the wire.

import { err, ok, type Result } from "@platos/kernel";

import { END_USER_TOKEN, repositoryUnavailable, SECRET_TOKEN, type ToolDeclarationIntake } from "../../domain/index.js";
import type {
  DiscoveryOutcome,
  DiscoveryRequest,
  DispatchOutcome,
  DispatchRequest,
  ToolDispatch,
} from "../ports/index.js";

export class InMemoryToolDispatch implements ToolDispatch {
  /** Every request that reached the wire, in order. Assert emptiness. */
  readonly requests: DispatchRequest[] = [];
  readonly discoveries: DiscoveryRequest[] = [];

  private outcomes: DispatchOutcome[] = [];
  private discovered: readonly ToolDeclarationIntake[] = [];
  private discoveryFailure: string | null = null;

  /** Queue the next outcome. Exhausted queues fall back to a plain success. */
  willAnswer(...outcomes: readonly DispatchOutcome[]): void {
    this.outcomes = [...this.outcomes, ...outcomes];
  }

  willDiscover(tools: readonly ToolDeclarationIntake[]): void {
    this.discovered = tools;
    this.discoveryFailure = null;
  }

  willFailDiscovery(reason: string): void {
    this.discoveryFailure = reason;
  }

  async dispatch(request: DispatchRequest): Promise<Result<DispatchOutcome>> {
    const leaked = this.residual(request);
    if (leaked !== null) {
      return err(repositoryUnavailable(`template_reached_the_wire:${leaked}`));
    }
    this.requests.push(request);
    const next = this.outcomes.shift();
    return ok(next ?? { kind: "succeeded", result: { ok: true }, latencyMs: 12 });
  }

  async discover(request: DiscoveryRequest): Promise<Result<DiscoveryOutcome>> {
    this.discoveries.push(request);
    if (this.discoveryFailure !== null) {
      return err(repositoryUnavailable(this.discoveryFailure));
    }
    return ok({ tools: this.discovered });
  }

  private residual(request: DispatchRequest): string | null {
    const values = [
      ...Object.values(request.target.headers),
      ...(request.target.url === null ? [] : [request.target.url]),
    ];
    for (const token of [END_USER_TOKEN, SECRET_TOKEN]) {
      if (values.some((value) => value.includes(token))) return token;
    }
    return null;
  }
}
