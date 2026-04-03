import pino from "pino";

export const log = pino({
  name: "mail-service",
  level: process.env["LOG_LEVEL"] ?? "info",
});