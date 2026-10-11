import { compile, createSession } from "@tinta-lang/engine";
import { mountReader } from "@tinta-lang/reader";

export function mount(host, standalone) {
  const source = `@slider amount = 2 (min: 0, max: 10, step: 1, label: "Amount")

Value: {{ amount }}

@data readings
name:text | value:number
A | 2
B | 5
@end
@chart bar readings (x: "name", y: "value")
`;
  const program = compile({
    text: source,
    uri: "tinta:consumer-browser",
    profile: "tinta",
  });
  if (!program.ok) throw new Error(JSON.stringify(program.diagnostics));
  const session = createSession(program.value);
  if (!session.ok) throw new Error(JSON.stringify(session.diagnostics));
  const mounted = (standalone ?? mountReader)(
    session.value,
    { nativeElement: host },
    { assets: new Map() },
  );
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.diagnostics));
  return () => {
    mounted.value.destroy();
    session.value.destroy();
  };
}
