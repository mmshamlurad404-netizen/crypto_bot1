import pino from "pino";

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    base: { app: "nobitex-sentiment-bot" },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      level === "debug" || level === "trace"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
        : undefined,
  });
}
