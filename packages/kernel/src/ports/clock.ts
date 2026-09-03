// ADR M0.3 §4 kernel port: Clock.
//
// Domain and application code never reads the wall clock directly. Time is an
// input, so a use case that expires a session, rotates a key or closes a budget
// period is exercisable in memory at any instant.

export interface Clock {
  now(): Date;
}
