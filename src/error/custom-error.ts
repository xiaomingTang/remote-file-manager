import { MSG } from "./message";

type MessageKey = keyof typeof MSG;

export class CustomError extends Error {
  name = "CustomError";

  code: MessageKey;

  constructor(code: MessageKey, message?: string) {
    const finalMessage =
      message || MSG[code] || code || "An unknown error occurred.";
    super(finalMessage);
    this.code = code;
  }

  static toCustomError(error: unknown): CustomError {
    if (error instanceof CustomError) {
      return error;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string"
    ) {
      return new CustomError((error as { code: string }).code as MessageKey);
    }
    const message = error instanceof Error ? error.message : String(error);
    const newError = new CustomError("unknownError", message);
    return newError;
  }

  public v(
    obj: Record<string, string | number | boolean | null | undefined>,
  ): this {
    const messageTemplate = this.message;
    const message = messageTemplate.replace(/{{(\w+)}}/g, (match, key) => {
      if (key in obj) {
        return String(obj[key]);
      }
      return match;
    });
    this.message = message;
    return this;
  }
}
