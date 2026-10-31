import pino from "pino";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

class PinoStructuredLogger implements Logger {
  private readonly instance: pino.Logger;

  constructor(instance: pino.Logger) {
    this.instance = instance;
  }

  public debug(msg: string, fields: LogFields = {}): void {
    this.instance.debug(fields, msg);
  }

  public info(msg: string, fields: LogFields = {}): void {
    this.instance.info(fields, msg);
  }

  public warn(msg: string, fields: LogFields = {}): void {
    this.instance.warn(fields, msg);
  }

  public error(msg: string, fields: LogFields = {}): void {
    this.instance.error(fields, msg);
  }

  public child(bindings: LogFields): Logger {
    return new PinoStructuredLogger(this.instance.child(bindings));
  }
}

export function createStructuredLogger(options?: {
  level?: string;
  service?: string;
}): Logger {
  const level = options?.level ?? process.env["LOG_LEVEL"] ?? "info";
  const baseLogger = pino({
    level,
    base: {
      service: options?.service ?? "zerocut-web",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return new PinoStructuredLogger(baseLogger);
}
