import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import fc from "fast-check";
import { propertyRuns } from "../support/properties.mjs";
import { performanceCorpus } from "../../scripts/performance-corpus.mjs";
import { compile, createSession } from "../../packages/engine/dist/index.js";
import {
  createStateSnapshot,
  validateStateSnapshot,
  packSource,
  openBundle,
  unwrap,
} from "../../packages/artifacts/dist/index.js";
import { base, controls } from "../../apps/studio/dist/protocol.js";

const input = (text) => ({
  text,
  uri: "tinta:qualification",
  profile: "tinta",
});

test("locked performance sources preserve declared size and complete within resource limits", () => {
  const corpus = performanceCorpus();
  const locked = JSON.parse(
    readFileSync("tests/fixtures/performance-corpus.json", "utf8"),
  );
  expect(
    corpus.map(({ name, seed, bytes, sha256 }) => ({
      name,
      seed,
      bytes,
      sha256,
    })),
  ).toEqual(locked);
  expect(corpus.find((item) => item.name === "large").bytes).toBe(2097152);
  for (const { name, source } of corpus) {
    const result = compile(input(source));
    if (name === "large") {
      // The large corpus is permitted to stop at a documented operation limit.
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0].code).toBe("E_LIMIT");
      expect(result.diagnostics[0].details.limitName).toBe("compileOperations");
      continue;
    }
    expect(result.ok, `${name}: ${JSON.stringify(result.diagnostics)}`).toBe(
      true,
    );
    const session = createSession(result.value);
    expect(session.ok, `${name}: ${JSON.stringify(session.diagnostics)}`).toBe(
      true,
    );
    session.value.destroy();
  }
}, 30000);

test("whole-revision mark limit accepts 32000 and rejects an additional figure atomically", () => {
  const { source } = performanceCorpus().find((item) => item.name === "marks");
  const program = unwrap(
    compile(
      input(
        "@toggle extra = false\n" +
          source +
          '\n@when extra\n@chart scatter records (x: "x", y: "value_0")\n@end\n',
      ),
    ),
  );
  const session = unwrap(createSession(program));
  const previous = session.getRevision();
  let notifications = 0;
  session.subscribe(() => notifications++);
  const result = session.setControl("extra", true);
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0].code).toBe("E_LIMIT");
  expect(result.diagnostics[0].details.limitName).toBe("documentChartMarks");
  expect(session.getRevision()).toBe(previous);
  expect(notifications).toBe(0);
  session.destroy();
});

test("seeded snapshot maps never mutate answers or source on rejection", () => {
  const program = unwrap(compile(input("@slider answer = 1\n")));
  const session = unwrap(createSession(program));
  const snapshot = createStateSnapshot(session);
  fc.assert(
    fc.property(fc.jsonValue(), (candidate) => {
      const before = session.getRevision();
      const result = validateStateSnapshot(program, {
        ...snapshot,
        controls: candidate,
      });
      expect(typeof result.ok).toBe("boolean");
      expect(session.getRevision()).toBe(before);
    }),
    { seed: 730242, numRuns: propertyRuns },
  );
  session.destroy();
});

test("seeded bundle mutations fail closed or preserve validated source", async () => {
  const packed = unwrap(
    await packSource(unwrap(compile(input("# Synthetic\n"))), new Map()),
  ).bytes;
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: packed.length - 1 }),
      fc.integer({ min: 1, max: 255 }),
      async (position, mask) => {
        const bytes = packed.slice();
        bytes[position] ^= mask;
        const result = await openBundle(bytes);
        if (result.ok)
          expect(new TextDecoder().decode(result.value.source.bytes)).toBe(
            "# Synthetic\n",
          );
        else expect(result.diagnostics.length).toBeGreaterThan(0);
      },
    ),
    { seed: 730243, numRuns: propertyRuns },
  );
});

test("seeded host messages cannot acquire a capability through arbitrary JSON", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (candidate) => {
      const before = JSON.stringify(candidate);
      expect(base(candidate)).toBe(false);
      expect(typeof controls(candidate)).toBe("boolean");
      expect(JSON.stringify(candidate)).toBe(before);
    }),
    { seed: 730244, numRuns: propertyRuns },
  );
});

test("release evidence cannot hide missing, duplicated or stale manual reviews", async () => {
  const { reviewBlockers, requiredReviews } =
    await import("../../scripts/qualification-evidence.mjs");
  const candidate = {
    commit: "a".repeat(40),
    dirty: false,
    manifestSha256: "b".repeat(64),
  };
  expect(reviewBlockers(undefined, candidate)).toHaveLength(
    requiredReviews.length + 2,
  );
  const evidence = {
    candidateCommit: candidate.commit,
    manifestSha256: candidate.manifestSha256,
    reviews: requiredReviews.map((id) => ({
      id,
      status: "PASS",
      reviewer: "Synthetic validator fixture",
      utc: "2026-10-08T00:00:00Z",
      environment: "Synthetic test environment",
      procedure: "Synthetic record validation only",
      observations: "Not actual acceptance",
      record: "synthetic-record.json",
    })),
  };
  expect(reviewBlockers(evidence, candidate)).toEqual([]);
  expect(reviewBlockers(evidence, { ...candidate, dirty: true })).toHaveLength(
    1,
  );
  expect(
    reviewBlockers({ ...evidence, candidateCommit: "wrong" }, candidate),
  ).toHaveLength(1);
  evidence.reviews.push(evidence.reviews[0]);
  expect(reviewBlockers(evidence, candidate)).toHaveLength(1);
  evidence.reviews[1].status = "NOT_RUN";
  expect(reviewBlockers(evidence, candidate)).toHaveLength(2);
});
