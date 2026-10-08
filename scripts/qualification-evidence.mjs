export const requiredReviews = [
  "cli-macos-arm64",
  "cli-linux-x64",
  "cli-windows-x64",
  "safari-voiceover",
  "firefox-nvda",
  "ios-safari",
  "keyboard-visual",
  "security-review",
  "normative-traceability",
  "performance-reference",
  "owner-acceptance",
];

export function reviewBlockers(evidence, candidate) {
  const blockers = [];
  if (!candidate.commit || candidate.dirty) {
    blockers.push("A frozen candidate commit is required.");
  }
  if (!evidence || evidence.candidateCommit !== candidate.commit) {
    blockers.push("Review evidence does not identify the candidate commit.");
  }
  if (evidence?.manifestSha256 !== candidate.manifestSha256) {
    blockers.push("Review evidence does not match the artifact manifest.");
  }
  for (const id of requiredReviews) {
    const matches = Array.isArray(evidence?.reviews)
      ? evidence.reviews.filter((review) => review?.id === id)
      : [];
    const review = matches[0];
    const valid =
      matches.length === 1 &&
      review.status === "PASS" &&
      [
        "reviewer",
        "utc",
        "environment",
        "procedure",
        "observations",
        "record",
      ].every(
        (key) =>
          typeof review[key] === "string" && review[key].trim().length > 0,
      ) &&
      Number.isFinite(Date.parse(review.utc));
    if (!valid) blockers.push(`Missing or incomplete acceptance: ${id}`);
  }
  return blockers;
}
