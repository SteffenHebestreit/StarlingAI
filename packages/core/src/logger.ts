import pino from "pino";

const LOGGER_KEY = Symbol.for("starlingai.logger");
type AppLogger = ReturnType<typeof createLogger>;

type GlobalLoggerState = typeof globalThis & {
  [LOGGER_KEY]?: AppLogger;
};

function createLogger() {
  return pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    transport: process.env["NODE_ENV"] !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  });
}

const globalLoggerState = globalThis as GlobalLoggerState;
const existingLogger = globalLoggerState[LOGGER_KEY];

export const logger = (existingLogger ?? createLogger()) as AppLogger;

if (!globalLoggerState[LOGGER_KEY]) {
  globalLoggerState[LOGGER_KEY] = logger;
}

export function childLogger(name: string, meta?: Record<string, unknown>) {
  return logger.child({ name, ...meta });
}
