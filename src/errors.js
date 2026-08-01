export class GiveurlError extends Error {
  constructor(message, { code = "GIVEURL_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = "GiveurlError";
    this.code = code;
  }
}

export class UsageError extends GiveurlError {
  constructor(message) {
    super(message, { code: "INVALID_USAGE" });
    this.name = "UsageError";
  }
}
