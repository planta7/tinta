export function qualificationOptions(args) {
  const options = { automatedOnly: false, supplementary: false };
  while (args.length) {
    const option = args.shift();
    if (option === "--automated-only" && !options.automatedOnly)
      options.automatedOnly = true;
    else if (option === "--evidence" && !options.evidencePath && args[0])
      options.evidencePath = args.shift();
    else if (
      option === "--performance" &&
      !options.supplementary &&
      args.shift() === "supplementary"
    )
      options.supplementary = true;
    else throw new Error(`Invalid qualification option: ${option}`);
  }
  if (options.supplementary && !options.automatedOnly)
    throw new Error("Supplementary performance requires --automated-only.");
  return options;
}

export function automatedBlockers(initial, candidate, results) {
  const blockers = [];
  if (!candidate.commit || candidate.dirty)
    blockers.push("A frozen candidate commit is required.");
  if (
    initial.commit !== candidate.commit ||
    initial.sourceSha256 !== candidate.sourceSha256
  )
    blockers.push("Candidate source changed during verification.");
  if (!candidate.manifestSha256)
    blockers.push("Candidate artifact manifest is unavailable.");
  if (!results.length || results.some((result) => result.exitCode !== 0))
    blockers.push("One or more automated commands failed.");
  return blockers;
}

export function performanceExitCode({ pass, complete, supplementary }) {
  return complete && (pass || supplementary) ? 0 : 1;
}

export function qualificationExitCode(report, automatedOnly) {
  return (automatedOnly ? report.automatedStatus : report.status) === "PASS"
    ? 0
    : 1;
}
