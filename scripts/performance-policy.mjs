export const studioBudgets = Object.freeze({
  typingP95: 100,
  controlP95: 150,
  previewP95: 1000,
  maximumTask: 200,
  longTaskTarget: 50,
});

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    maximum: sorted.at(-1) ?? null,
  };
}

function validRecord(record, preview) {
  const { start, end, previewEnd, tasks, trusted } = record;
  return (
    trusted === true &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end >= start &&
    (!preview || (Number.isFinite(previewEnd) && previewEnd >= end)) &&
    Array.isArray(tasks) &&
    tasks.every(
      (task) =>
        Number.isFinite(task.start) &&
        Number.isFinite(task.duration) &&
        task.duration > 0 &&
        typeof task.context === "string",
    )
  );
}

export function assessStudioRuns(runs) {
  const summaries = runs.map(({ typing, controls }) => {
    const complete =
      typing.length === 50 &&
      controls.length === 50 &&
      typing.every((record) => validRecord(record, true)) &&
      controls.every((record) => validRecord(record, false));
    if (!complete)
      return { pass: false, reason: "Incomplete or invalid samples" };
    const typingLatency = distribution(
      typing.map(({ start, end }) => end - start),
    );
    const controlLatency = distribution(
      controls.map(({ start, end }) => end - start),
    );
    const previewLatency = distribution(
      typing.map(({ start, previewEnd }) => previewEnd - start),
    );
    const actions = [...typing, ...controls];
    const tasks = actions.flatMap((action) => action.tasks);
    const maximumTask = Math.max(0, ...tasks.map((task) => task.duration));
    return {
      typingLatency,
      controlLatency,
      previewLatency,
      longTasks: {
        count: tasks.length,
        maximum: maximumTask,
        excessMilliseconds: tasks.reduce(
          (total, task) =>
            total + Math.max(0, task.duration - studioBudgets.longTaskTarget),
          0,
        ),
        actionFraction:
          actions.filter((action) => action.tasks.length > 0).length /
          actions.length,
      },
      pass:
        typingLatency.p95 <= studioBudgets.typingP95 &&
        controlLatency.p95 <= studioBudgets.controlP95 &&
        previewLatency.p95 <= studioBudgets.previewP95 &&
        maximumTask <= studioBudgets.maximumTask,
    };
  });
  return {
    budgets: studioBudgets,
    summaries,
    pass: runs.length === 3 && summaries.every((summary) => summary.pass),
  };
}
