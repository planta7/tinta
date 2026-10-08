import { Budget, fail } from "./common.js";

/** Reject cycles, accessors and excessive structure before recursive schema traversal. */
export function inspect(value: unknown, budget: Budget): void {
  const stack: {
      value: unknown;
      depth: number;
      leave?: boolean;
    }[] = [{ value, depth: 0 }],
    seen = new Set<object>();
  let nodes = 0,
    units = 0;

  while (stack.length) {
    const item = stack.pop()!;
    if (item.leave) {
      seen.delete(item.value as object);
      continue;
    }
    budget.charge();
    if (++nodes > 2000000 || item.depth > 256)
      fail("E_LIMIT", budget.span, "decode");
    if (typeof item.value === "string") {
      units += item.value.length;
      if (units > 41943040) fail("E_LIMIT", budget.span, "decode");
    }
    if (!item.value || typeof item.value !== "object") continue;
    if (seen.has(item.value)) fail("E_PROTOCOL", budget.span, "decode");
    seen.add(item.value);
    stack.push({ ...item, leave: true });
    const proto: unknown = Object.getPrototypeOf(item.value);
    if (
      proto !== Object.prototype &&
      proto !== Array.prototype &&
      proto !== null
    )
      fail("E_PROTOCOL", budget.span, "decode");
    for (const key of Reflect.ownKeys(item.value)) {
      if (typeof key !== "string") fail("E_PROTOCOL", budget.span, "decode");
      if (Array.isArray(item.value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key)!;
      if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        fail("E_PROTOCOL", budget.span, "decode");
      stack.push({ value: descriptor.value as unknown, depth: item.depth + 1 });
    }
  }
}
