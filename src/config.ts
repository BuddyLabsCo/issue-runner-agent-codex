export interface Options {
  logLevel: "info" | "error";
  readyTimeout: number;
  retryLimit: number;
  retryDelay: readonly number[];
  handoffRecoveryDelaySeconds: number;
}

export function parseOptions(config: unknown): Options {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("enhancements must be an options object");
  }
  const values: Record<string, unknown> = { ...config };
  const {
    logLevel = "error",
    readyTimeout = 20,
    retryLimit = 3,
    retryDelay = [10, 20, 40],
    handoffRecoveryDelaySeconds = 120,
  } = values;
  if (logLevel !== "info" && logLevel !== "error")
    throw new TypeError("enhancements.logLevel must be info or error");
  const nonnegative = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!nonnegative(readyTimeout) || readyTimeout === 0) {
    throw new TypeError(
      "enhancements.readyTimeout must be finite and positive",
    );
  }
  if (!nonnegative(retryLimit) || !Number.isInteger(retryLimit)) {
    throw new TypeError(
      "enhancements.retryLimit must be a nonnegative integer",
    );
  }
  if (!Array.isArray(retryDelay) || retryDelay.length === 0) {
    throw new TypeError(
      "enhancements.retryDelay must be a nonempty list of finite nonnegative delays",
    );
  }
  const delays = Array.from<unknown>(retryDelay);
  if (!delays.every(nonnegative)) {
    throw new TypeError(
      "enhancements.retryDelay must be a nonempty list of finite nonnegative delays",
    );
  }
  if (!nonnegative(handoffRecoveryDelaySeconds)) {
    throw new TypeError(
      "enhancements.handoffRecoveryDelaySeconds must be finite and nonnegative",
    );
  }
  return {
    logLevel,
    readyTimeout,
    retryLimit,
    retryDelay: delays,
    handoffRecoveryDelaySeconds,
  };
}
