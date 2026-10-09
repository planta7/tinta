export type StudioRoute =
  | { section: "home" | "examples" | "snippets" | "recovery" }
  | { section: "document"; id: string; editing: boolean };

export function readRoute(): StudioRoute | undefined {
  const parts = location.hash.slice(1).split("/").filter(Boolean);
  if (!parts.length) return undefined;
  if (
    parts.length === 1 &&
    ["home", "examples", "snippets", "recovery"].includes(parts[0]!)
  )
    return {
      section: parts[0] as "home" | "examples" | "snippets" | "recovery",
    };
  if (
    parts.length === 3 &&
    parts[0] === "document" &&
    /^[a-zA-Z0-9-]{1,128}$/.test(parts[1]!) &&
    ["read", "edit"].includes(parts[2]!)
  )
    return { section: "document", id: parts[1]!, editing: parts[2] === "edit" };
  return { section: "home" };
}

export function writeRoute(route: StudioRoute, replace = false): void {
  const hash =
    route.section === "document"
      ? `#/document/${route.id}/${route.editing ? "edit" : "read"}`
      : `#/${route.section}`;
  if (location.hash !== hash)
    history[replace ? "replaceState" : "pushState"](null, "", hash);
}
