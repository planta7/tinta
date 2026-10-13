export async function confirmPerformance(
  initial,
  measure,
  withinBudget,
  record = () => {},
) {
  const confirmation = { status: "FAIL", attempts: [initial] };
  record(confirmation);
  const passes = (value) => {
    const result = withinBudget(value);
    if (typeof result !== "boolean")
      throw new Error("Performance assessment did not return a boolean.");
    return result;
  };

  try {
    const outcomes = [passes(initial)];
    if (outcomes[0]) {
      confirmation.status = "PASS";
      return confirmation;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const measurement = await measure(attempt);
      confirmation.attempts.push(measurement);
      record(confirmation);
      outcomes.push(passes(measurement));
    }
    const failures = outcomes.filter((value) => !value).length;
    confirmation.status = failures === 1 ? "UNSTABLE" : "FAIL";
    return confirmation;
  } catch (error) {
    confirmation.error = String(error.stack ?? error);
    throw error;
  }
}

export function samplesWithinBudget(measurement, budgetMs) {
  if (
    !Array.isArray(measurement.samples) ||
    measurement.samples.length !== 30 ||
    measurement.samples.some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isFinite(measurement.p95Ms) ||
    measurement.p95Ms !== [...measurement.samples].sort((a, b) => a - b)[28]
  )
    throw new Error("Incomplete or invalid performance samples.");
  return measurement.p95Ms < budgetMs;
}

export function responsivenessWithinBudget(measurement) {
  if (
    !Number.isSafeInteger(measurement.count) ||
    measurement.count <= 0 ||
    !Number.isFinite(measurement.loopP95Ms) ||
    !Number.isFinite(measurement.loopMaxMs) ||
    measurement.loopP95Ms < 0 ||
    measurement.loopMaxMs < measurement.loopP95Ms
  )
    throw new Error("Incomplete or invalid responsiveness measurement.");
  return measurement.loopP95Ms < 50 && measurement.loopMaxMs <= 100;
}

export function performanceStatus(confirmations, resourcesPass) {
  const statuses = Object.values(confirmations).map((value) => value.status);
  if (!resourcesPass || statuses.some((status) => status === "FAIL"))
    return "FAIL";
  return statuses.includes("UNSTABLE") ? "UNSTABLE" : "PASS";
}

export function emitPerformanceWarnings(
  report,
  {
    githubActions = process.env.GITHUB_ACTIONS === "true",
    log = console.warn,
  } = {},
) {
  for (const warning of report?.warnings ?? [])
    log(
      githubActions
        ? `::warning title=Unstable native performance::${warning}`
        : `WARNING: ${warning}`,
    );
}
