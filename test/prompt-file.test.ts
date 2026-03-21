import { describe, it, expect } from "vitest";
import { PROMPT_FILE_NAME } from "../prompt-file.ts";

describe("PROMPT_FILE_NAME", () => {
  it("has the expected value", () => {
    expect(PROMPT_FILE_NAME).toBe("AUTORESEARCH_PROMPT.md");
  });
});
