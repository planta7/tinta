import assert from "node:assert/strict";
import semver from "semver";
import { encode, hash } from "./publication-journal.mjs";

export function validateIntent(intent, plan, now) {
  assert.deepEqual(Object.keys(intent).sort(), [
    "candidate",
    "expiresAt",
    "publisherSha",
    "reconciliation",
    "releaseId",
  ]);
  assert.equal(
    intent.candidate,
    plan.candidate,
    "Approval belongs to another candidate",
  );
  assert.equal(
    intent.publisherSha,
    plan.publisherSha,
    "Unreviewed publisher revision",
  );
  assert.equal(intent.releaseId, plan.releaseId);
  assert.ok(
    now < Date.parse(intent.expiresAt) && now < Date.parse(plan.expiresAt),
    "Stale approval or expired candidate",
  );
  assert.ok(Date.parse(intent.expiresAt) <= Date.parse(plan.expiresAt));
  assert.ok(
    intent.reconciliation === null ||
      /^[a-f0-9]{64}$/.test(intent.reconciliation),
  );
}

export function dependencyOrder(targets) {
  const result = [];
  const visiting = new Set();
  const done = new Set();
  const visit = (target) => {
    if (done.has(target.name)) return;
    assert.ok(!visiting.has(target.name), "Dependency cycle");
    visiting.add(target.name);
    for (const dependency of target.dependencies) {
      const next = targets.find((item) => item.name === dependency.name);
      assert.ok(
        next && next.version === dependency.version,
        "Incomplete dependency closure",
      );
      visit(next);
    }
    done.add(target.name);
    result.push(target);
  };
  targets.forEach(visit);
  return result;
}

export function promotionReview(observed, targets) {
  for (const target of targets) {
    const current = observed[target.name];
    assert.ok(
      current === null || semver.valid(current),
      "Invalid remote channel version",
    );
    assert.ok(
      current === null || !semver.gt(current, target.version),
      "Newer channel version prevents backward promotion",
    );
  }
  return hash(encode(observed));
}

/** No service implementation or credential acquisition runs before the gate. */
export async function publishRelease({
  gate,
  journal,
  adapters,
  intent,
  now,
  phase = "all",
}) {
  const plan = await gate();
  validateIntent(intent, plan, now());
  await journal.acquire();
  try {
    const releases = (await journal.read()) ?? {};
    for (const record of Object.values(releases)) {
      assert.ok(
        record.releaseId !== plan.releaseId ||
          record.candidate === plan.candidate,
        "Release identity collision",
      );
    }
    const record = releases[plan.candidate] ?? {
      candidate: plan.candidate,
      releaseId: plan.releaseId,
      status: "pending",
      items: {},
    };
    record.status = "pending";
    releases[plan.candidate] = record;
    const save = () => journal.save(releases);
    await save();
    const packages = dependencyOrder(
      plan.targets.filter((t) => t.kind === "npm"),
    );
    for (const adapter of Object.values(adapters))
      await adapter.preflight(plan);
    const initialChannels = {};
    for (const target of packages) {
      initialChannels[target.name] = await adapters.npm.channel(target);
    }
    promotionReview(initialChannels, packages);
    const step = async (key, operation, promoted = false) => {
      validateIntent(intent, plan, now());
      const item = record.items[key] ?? { status: "pending", attempts: 0 };
      record.items[key] = item;
      await save();
      let remote = await operation.read();
      if (remote === null) {
        const destination = key.startsWith("npm:")
          ? "npm"
          : key === "marketplace" || key.startsWith("marketplace:")
            ? "marketplace"
            : key.startsWith("channel:")
              ? "promote"
              : "github";
        assert.ok(
          phase === "all" || phase === destination,
          "Previous destination is incomplete",
        );
        if (item.attempts > 0 && operation.retryAbsent !== true) {
          const observation = {
            candidate: plan.candidate,
            operation: key,
            attempts: item.attempts,
            observed: "absent",
          };
          const reconciliation = hash(encode(observation));
          record.status = "reconciliation-required";
          record.reconciliation = { ...observation, digest: reconciliation };
          await save();
          assert.equal(
            intent.reconciliation,
            reconciliation,
            "Unknown submission; reconcile destination before retry",
          );
        }
        assert.ok(item.attempts < 3, "Bounded submission attempts exhausted");
        item.status = "submitted";
        item.attempts += 1;
        await save();
        try {
          await operation.write();
        } catch (error) {
          item.status = "unknown";
          item.error =
            error.code === "CREDENTIAL_EXPIRED"
              ? "credential-expired"
              : "submission-outcome-unknown";
          await save();
          remote = await operation.read();
          if (remote === null)
            throw new Error(
              "Submission outcome unknown; reconciliation required",
              { cause: error },
            );
        }
        if (remote === null) remote = await operation.read();
      }
      try {
        assert.ok(remote !== null, "Destination indexing pending");
        const receipt = await operation.verify(remote);
        if (item.status !== "promoted") item.receipt = receipt;
        item.status = promoted ? "promoted" : "verified";
        delete item.error;
        await save();
      } catch (error) {
        item.status = "failed";
        item.error = "verification-failed";
        await save();
        throw error;
      }
    };
    for (const target of packages) {
      await step(`npm:${target.name}`, adapters.npm.upload(target, plan));
    }
    await adapters.npm.verifyInstall(packages, plan);
    if (phase === "npm") return structuredClone(record);
    await step(
      "marketplace",
      adapters.marketplace.upload(
        plan.targets.find((t) => t.kind === "vsix"),
        plan,
      ),
    );
    await step(
      "marketplace:visibility",
      adapters.marketplace.visibility(
        plan.targets.find((t) => t.kind === "vsix"),
      ),
    );
    if (phase === "marketplace") return structuredClone(record);
    const observed = {};
    for (const target of packages)
      observed[target.name] = await adapters.npm.channel(target);
    const review = promotionReview(observed, packages);
    const alreadyPromoted = packages.filter(
      (t) => observed[t.name] === t.version,
    );
    if (
      alreadyPromoted.length > 0 &&
      alreadyPromoted.length < packages.length
    ) {
      record.status = "reconciliation-required";
      record.reconciliation = { digest: review, observed };
      await save();
      assert.equal(
        intent.reconciliation,
        review,
        "Partial promotion requires reviewed reconciliation",
      );
    }
    record.promotion ??= {
      observed,
      desired: Object.fromEntries(packages.map((t) => [t.name, t.version])),
    };
    await save();
    for (const target of packages) {
      await step(
        `channel:${target.name}`,
        adapters.npm.promote(target, observed[target.name]),
        true,
      );
    }
    if (phase === "promote") return structuredClone(record);
    for await (const operation of adapters.github.operations(plan)) {
      await step(
        `github:${operation.key}`,
        operation,
        operation.key === "publish",
      );
    }
    record.status = "promoted";
    await save();
    return structuredClone(record);
  } finally {
    await journal.release();
  }
}
