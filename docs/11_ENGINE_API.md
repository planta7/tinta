# Portable engine API

`@tinta-lang/engine` exports `compile`, `createSession`, `encodeProgram`, `decodeProgram`, `importCsv` and `importJson`. Inputs, results and immutable values follow [the public contract](../contracts/public-api.d.ts).

```ts
import { compile, createSession } from "@tinta-lang/engine";

const compiled = compile({
  uri: "tinta:example",
  profile: "tinta",
  text: "@slider people = 5\n@calc total = people * 19\n{{ money(total) }}\n",
});

if (compiled.ok) {
  const created = createSession(compiled.value);
  if (created.ok) {
    const session = created.value;
    const changed = session.setControl("people", 6);
    if (changed.ok) {
      const total = changed.value.values.total;
      // The committed total is 114.
    }
    session.destroy();
  }
}
```

Compilation binds forward references, checks the complete dependency graph and types, validates static directive properties and exact decimal control grids, and evaluates constants. A successful compile can still fail initial evaluation: a visible division by zero, an empty mean or an invalid chart domain depends on the candidate state. Inspect every `Result` before accessing its value.

A session starts at revision zero. `setControl` and partial `setControls` validate and evaluate a whole candidate before committing it. Failure retains the previous immutable revision. Identical updates and resetting an unchanged baseline do not increment the revision or notify listeners. An explicit baseline must contain every control exactly once and satisfy its domain; reset returns to that baseline. Without a baseline, reset uses authored defaults.

Subscriptions run in registration order after a commit. They do not fire immediately. Synchronous mutations during notification fail with `E_PROTOCOL`. A failing subscriber produces an `E_INTERNAL` host diagnostic in the mutation result, leaves the committed revision intact and does not prevent other subscribers from running. Destroy is idempotent; getters retain the last revision and subsequent mutations fail.

Revisions include scalar/list values, typed tables, safe resolved nodes and prepared chart data for all seven chart types. Views retain source row identity and schema. False conditions defer their inline outputs and chart preparation; calculations, views and collapsed details remain eager. Chart preparation checks series, selection domains, ordering, finite numeric domains, histogram boundaries and shared mark/operation budgets. SVG geometry, DOM mounting, legend interactions, file operations and exports are separate capabilities.

`encodeProgram` accepts a validated in-process program. `decodeProgram` treats its argument as untrusted structured data: it bounds traversal, rejects accessors/cycles/unknown fields, validates the generated closed schema, recompiles the embedded source, and checks structural equality with the canonical IR. That final check validates source hashes, spans, IDs, names, graphs, types, rows and grids. Decoding constructs a separate immutable program; editing an encoded object is not a supported way to edit source. The decoder includes the portable compiler, which is measured in the combined bundle-size check.

The [closed JSON schema](../schemas/program.schema.json) and standalone validator are generated from the integration contract with the locked TypeScript and Ajv builds. Runtime validation does not generate code. Regenerate using `node scripts/program-schema.mjs`; check reproducibility using `node scripts/program-schema.mjs --check`. The generated validator and registry are excluded from authored-code coverage and checked separately. Ajv's retained license is in `THIRD_PARTY_NOTICES.txt`.

CSV and JSON importers consume explicit UTF-8 byte arrays and return an embedded `@data` source candidate, column mapping and row count. They neither read files nor modify a document. CSV inference examines every row; JSON retains scalar types and rejects duplicate keys before values can be overwritten. Optional column mappings are validated completely. Host applications own preview, approval, insertion and undo.

From the repository root with the pinned tools:

```sh
pnpm install --frozen-lockfile
pnpm verify --suite semantics
pnpm test:conformance semantics
```

The semantic aggregate includes specification checks, generated-schema reproducibility, types, formatting/lint, dependency/license/architecture checks, unit/property tests and coverage, builds, offline browser portability, both conformance adapters and the portable bundle-size ceiling. The semantic adapter checks pure compilation and evaluation. DOM effects and file/export behavior are exercised by the separate browser and artifact suites.

## Read-only binding analysis

`analyzeProgram(program)` returns immutable name/type records from the same binding pass used by compilation and validated decoding. It accepts only engine-owned compiled or decoded programs, throwing `TypeError` for other objects. It does not compile, create a session, expose private maps or add fields to ProgramIR. Table records copy their ordered column schemas; list records include the `never` element type for empty lists. These are static types, independent of whether initial evaluation succeeds. Callers must still use `createSession` and destroy a successful temporary session before treating source as valid for preview or export.
