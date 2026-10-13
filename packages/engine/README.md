# @tinta-lang/engine

Compile and evaluate tinta documents. Create a session to change controls and receive a complete new document state after each valid change.

```ts
import { compile, createSession } from "@tinta-lang/engine";

const compiled = compile({
  uri: "tinta:example",
  profile: "tinta",
  text: "@slider people = 5\n@calc total = people * 19\n{{ total }}\n",
});

if (compiled.ok) {
  const created = createSession(compiled.value);
  if (created.ok) {
    created.value.setControl("people", 6);
    created.value.destroy();
  }
}
```

Check each result before using its value. An invalid control change leaves the previous state intact. This package does not mount a reader or access files.

See the [engine API](https://github.com/planta7/tinta/blob/main/docs/11_ENGINE_API.md).
