// The `MacroRecorder` port — where an in-progress recording lives.
//
// Recording a macro is a session: a caller starts one, every tool call it makes
// is appended, and stopping it finalises the steps into a `Macro` row. Nothing
// is persisted until the stop, so the in-flight recording is state that belongs
// to neither the domain nor the store.
//
// IT IS A PORT AND NOT A FIELD BECAUSE THE RUNNING SYSTEM'S VERSION IS LOST ON
// RESTART. The recording state is held in process memory, which means an
// operator recording a twelve-step macro loses it if the process cycles
// underneath them, silently, with no error — the next `record_stop` simply says
// there is no such recording. Modelling it as a port does not fix that; it makes
// it a property of the ADAPTER rather than of this context, so an installation
// can put a durable store behind the same interface without touching a rule.
//
// STARTING TWICE IS IDEMPOTENT. A second `start` for a caller that is already
// recording returns the LIVE recording rather than opening a second one or
// refusing. That is the source's behaviour and it is the right one: a surface
// that lost its recording id can ask again and get back the one it is already
// filling, instead of stranding it.

import type { EnvironmentScope, Result } from "@platos/kernel";

import type { ActorId, MacroStep } from "../../domain/index.js";

/** Which caller a recording belongs to. One live recording per caller. */
export interface RecorderKey {
  readonly scope: EnvironmentScope;
  /** The caller's session identity, whatever the transport authenticated. */
  readonly sessionId: string;
}

export interface MacroRecording {
  readonly recordingId: string;
  readonly scope: EnvironmentScope;
  readonly createdBy: ActorId;
  readonly steps: readonly MacroStep[];
  readonly startedAt: Date;
}

export interface MacroRecorder {
  /** Begin, or return the recording this caller is already filling. */
  start(key: RecorderKey, recordingId: string, createdBy: ActorId, at: Date): Promise<Result<MacroRecording>>;

  /** Append one step. A no-op when this caller is not recording. */
  append(key: RecorderKey, step: MacroStep): Promise<Result<void>>;

  read(key: RecorderKey): Promise<Result<MacroRecording | null>>;

  /**
   * Finalise and forget.
   *
   * Answers `null` when this caller has no live recording, or when the id does
   * not match the one it is filling — the second check is what stops a stale
   * surface from finalising a recording it did not start.
   */
  stop(key: RecorderKey, recordingId: string): Promise<Result<MacroRecording | null>>;
}
