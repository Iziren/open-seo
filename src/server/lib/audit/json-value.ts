export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Recursively normalize `unknown` into JSON-safe values, dropping
 * `undefined`, functions, and NaN (as null). Server-function responses
 * reject `unknown` index signatures at the type level, so untrusted
 * structures pass through here before leaving the server.
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? null : value;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const normalized = toJsonValue(item);
      if (normalized !== undefined) items.push(normalized);
    }
    return items;
  }
  if (typeof value === "object") {
    const record: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = toJsonValue(entry);
      if (normalized !== undefined) record[key] = normalized;
    }
    return record;
  }
  return undefined;
}

/** Normalize a record, guaranteeing an object (never an array or scalar). */
export function toJsonRecord(
  value: Record<string, unknown> | undefined,
): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined;
  const normalized = toJsonValue(value);
  return normalized !== null &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
    ? normalized
    : undefined;
}
