// Qualification increases every existing seeded property without changing its seed.
const requested = process.env.TINTA_PROPERTY_RUNS ?? "1000";
if (!["1000", "10000"].includes(requested)) {
  throw new Error("TINTA_PROPERTY_RUNS must be 1000 or 10000");
}
export const propertyRuns = Number(requested);
