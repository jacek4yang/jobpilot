export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly component: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(component: string, message: string, context?: Record<string, unknown>): void;
  info(component: string, message: string, context?: Record<string, unknown>): void;
  warn(component: string, message: string, context?: Record<string, unknown>): void;
  error(component: string, message: string, context?: Record<string, unknown>): void;
  /** Snapshot of recent entries, oldest first. */
  entries(): readonly LogEntry[];
  clear(): void;
}

/** Keys whose values are always redacted before an entry is stored. */
export const SENSITIVE_KEYS: readonly string[] = [
  "cookie",
  "cookies",
  "authorization",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "password",
  "passwd",
  "secret",
  "session",
  "sessionid",
  "credential",
  "credentials",
  "chat",
  "chatcontent",
  "chat_content",
  "message",
];

const REDACTED = "[redacted]";

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive.replace(/[-_\s]/g, "")));
};

/**
 * Recursively redacts anything that looks like a credential or private
 * message before it can reach the ring buffer, the UI, or an export.
 *
 * Depth-limited so that a hostile or cyclic object cannot hang the logger.
 */
export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Never persist anything that looks like a bearer token or cookie pair.
    return value
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `${REDACTED}`)
      .replace(/\b(token|sessionid|password|authorization)=[^;\s&]+/gi, `$1=${REDACTED}`);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redact(nested, depth + 1);
    }
    return output;
  }
  return "[unserializable]";
};
