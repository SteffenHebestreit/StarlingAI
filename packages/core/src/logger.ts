import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport: process.env["NODE_ENV"] !== "production"
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
    : undefined,
});

export function childLogger(name: string, meta?: Record<string, unknown>) {
  return logger.child({ name, ...meta });
}
