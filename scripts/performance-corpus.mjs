import { createHash } from "node:crypto";

export const corpusSeed = 730241;

function prose(bytes) {
  const sentence =
    "Local synthetic prose explains a reproducible measurement. ";
  let output = "";
  while (output.length < bytes) {
    output += sentence.repeat(16) + "\n\n";
  }
  return output.slice(0, bytes - 2) + "\n\n";
}

function controls(count) {
  return (
    Array.from(
      { length: count },
      (_, i) =>
        `@slider answer_${i} = 1 (min: 0, max: 10, label: "Answer ${i}")`,
    ).join("\n") + "\n\n"
  );
}

function table(name, rows, series = 1) {
  const header = [
    "x:number",
    ...Array.from({ length: series }, (_, i) => `value_${i}:number`),
  ].join(" | ");
  const values = Array.from({ length: rows }, (_, row) =>
    [
      row,
      ...Array.from(
        { length: series },
        (_, column) => ((corpusSeed + row * 17 + column * 31) % 997) + 1,
      ),
    ].join(" | "),
  );
  return `@data ${name}\n${header}\n${values.join("\n")}\n@end\n\n`;
}

function chart(name, series = 1) {
  const y =
    series === 1
      ? "row.value_0 * answer_0"
      : `[${Array.from({ length: series }, (_, i) => `"value_${i}"`).join(", ")}]`;
  return `@chart scatter ${name} (x: "x", y: ${y})\n\n`;
}

export function performanceCorpus() {
  const small =
    prose(20 * 1024) +
    controls(5) +
    table("records", 100) +
    chart("records").repeat(3);
  const medium =
    prose(200 * 1024) +
    controls(20) +
    Array.from({ length: 5 }, (_, i) => table(`records_${i}`, 1000)).join("") +
    Array.from({ length: 8 }, (_, i) => chart(`records_${i % 5}`)).join("");
  const dense = controls(1) + table("records", 2000, 6) + chart("records", 6);
  const marks =
    controls(1) +
    table("records", 2000, 6) +
    chart("records", 6).repeat(2) +
    chart("records", 4);
  const declarations =
    controls(128) +
    Array.from({ length: 320 }, (_, i) => `@let constant_${i} = ${i}\n`).join(
      "",
    ) +
    Array.from({ length: 64 }, (_, i) => table(`records_${i}`, 100, 14)).join(
      "",
    );
  const large = declarations + prose(2 * 1024 * 1024 - declarations.length);
  return Object.entries({ small, medium, large, dense, marks }).map(
    ([name, source]) => ({
      name,
      source,
      seed: corpusSeed,
      bytes: Buffer.byteLength(source),
      sha256: createHash("sha256").update(source).digest("hex"),
    }),
  );
}
