# Studio responsiveness budgets

Technical decision, 2026-10-08. Defines the interaction measurements and budgets used by Studio.

## Affected requirement

Traceability: REQ-18 and SC-040/SC-041. The changed assertion is covered by
`tests/unit/performance-policy.test.mjs` and `scripts/performance-browser.mjs`.

The Studio clause in `docs/07_VERIFICATION.md` previously required every
synchronous main-thread operation for the medium corpus to stay at or below
50ms. It is replaced by the Studio interaction protocol in that document.
Language semantics, resource limits, worker isolation, validated IR and existing
compile/evaluate, reader-update and export budgets are unchanged.

## Reason

The [Long Tasks API](https://www.w3.org/TR/longtasks-1/) reports event-loop tasks,
not individual application functions. Its 50ms reporting threshold is useful for
finding blocking work, but does not itself define acceptable product latency.
Several shorter tasks can delay input, while a single occasional long task does
not describe the whole interaction. Automation polling also adds work that can
be mistaken for product cost.

The replacement measures user-facing latency and retains a separate stall guard.
Typing has a 100ms p95 response target. Control response preserves the existing
150ms medium-document answer-update target. Preview completion allows one second,
including the existing 200ms debounce and presentation; the separate 750ms
compile/evaluate target still applies. The 200ms maximum task guard is a project
choice to reject substantial stalls; it is not a claim that a 200ms task is
imperceptible or that task duration equals an interaction score. These budgets
are fixed before the replacement benchmark is executed.

## Measurement and compatibility

Three independent contexts retain all measurements. Keyboard events drive the
actual editor and native control. Passive DOM observation replaces repeated
text searches during measurement. Two animation frames provide a conservative
paint-opportunity proxy; actual display presentation and real-device usability
depend on the physical device and browser. Browser scheduling, garbage collection and
instrumentation can contribute to observed tasks; attribution is contextual,
not function-level proof. The guard includes all observed tasks overlapping the
interaction rather than selectively deleting inconvenient samples.

The benchmark report
continues to show long tasks above 50ms, their frequency and excess duration.
Affected automated checks cover missing samples, exact boundaries, a single
extreme stall and failures in any of the three runs. No security validation is
removed, and no source-format or public API revision is needed.
