import { PassThrough, Readable } from "node:stream";
import { inspect } from "node:util";

import { expect, test, vi } from "vitest";

import { promptChoice, promptCredentials, readCredentials } from "./credentials.js";

test("reads a credential object across chunks", async () => {
  const input = Readable.from([Buffer.from('{"arl":'), Buffer.from('"abcdef"}')]);
  expect((await readCredentials(input))._unsafeUnwrap()).toEqual({ arl: "abcdef" });
});

test.each(["", "secret-not-json", "null", "[]", '"secret"'])(
  "invalid credentials return a safe error: %j",
  async (text) => {
    const result = await readCredentials(Readable.from([text]));
    expect(result._unsafeUnwrapErr().tag).toBe("invalid_input");
    expect(result._unsafeUnwrapErr().cause).toBeUndefined();
  },
);

test("oversized credential input is rejected", async () => {
  const result = await readCredentials(Readable.from(['{"arl":"', "a".repeat(8192), '"}']));
  expect(result._unsafeUnwrapErr().message).toBe("Credential input exceeds 8 KiB.");
});

test("stream errors do not expose credentials", async () => {
  const input = new PassThrough();
  const operation = readCredentials(input);
  input.destroy(new Error("private-credential"));
  const result = await operation;
  expect(result._unsafeUnwrapErr().tag).toBe("invalid_input");
  expect(inspect(result, { depth: null })).not.toContain("private-credential");
});

test("cancellation interrupts pending input", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const operation = readCredentials(input, { signal: controller.signal });
  controller.abort();
  expect((await operation)._unsafeUnwrapErr().tag).toBe("cancelled");
  expect(input.destroyed).toBe(true);
});

test("pre-cancelled input returns immediately", async () => {
  expect(
    (await readCredentials(new PassThrough(), { signal: AbortSignal.abort() }))._unsafeUnwrapErr()
      .tag,
  ).toBe("cancelled");
});

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { input, output, text: () => text };
}

test("the ARL prompt supports editing without echoing the credential", async () => {
  const { input, output, text } = terminal();
  const operation = promptCredentials(
    [{ id: "arl", label: "Deezer ARL", secret: true }],
    input,
    output,
  );
  await Promise.resolve();
  input.write("abcx\x7fdef\r");
  expect((await operation)._unsafeUnwrap()).toEqual({ arl: "abcdef" });
  expect(text()).toBe("Deezer ARL: \n");
  expect(input.listenerCount("keypress")).toBe(0);
});

test("Ctrl+C cancels the hidden prompt and restores raw mode", async () => {
  const { input, output, text } = terminal();
  const setRawMode = vi.fn<(enabled: boolean) => void>();
  Object.assign(input, { isTTY: true, setRawMode });
  const operation = promptCredentials(
    [{ id: "arl", label: "Deezer ARL", secret: true }],
    input,
    output,
  );
  await Promise.resolve();
  input.write("private-credential\x03");
  expect((await operation)._unsafeUnwrapErr().tag).toBe("cancelled");
  expect(text()).toBe("Deezer ARL: \n");
  expect(setRawMode).toHaveBeenNthCalledWith(1, true);
  expect(setRawMode).toHaveBeenLastCalledWith(false);
  expect(input.listenerCount("keypress")).toBe(0);
});

test("external cancellation interrupts the prompt", async () => {
  const { input, output } = terminal();
  const controller = new AbortController();
  const operation = promptCredentials(
    [{ id: "arl", label: "Deezer ARL", secret: true }],
    input,
    output,
    { signal: controller.signal },
  );
  await Promise.resolve();
  controller.abort();
  expect((await operation)._unsafeUnwrapErr().tag).toBe("cancelled");
  expect(input.listenerCount("keypress")).toBe(0);
});

test("EOF cancels the prompt instead of waiting indefinitely", async () => {
  const { input, output } = terminal();
  const operation = promptCredentials(
    [{ id: "arl", label: "Deezer ARL", secret: true }],
    input,
    output,
  );
  await Promise.resolve();
  input.end();
  expect((await operation)._unsafeUnwrapErr().tag).toBe("cancelled");
});

test("pre-cancelled prompts do not read or write the terminal", async () => {
  const { input, output, text } = terminal();
  const result = await promptCredentials(
    [{ id: "arl", label: "Deezer ARL", secret: true }],
    input,
    output,
    { signal: AbortSignal.abort() },
  );
  expect(result._unsafeUnwrapErr().tag).toBe("cancelled");
  expect(text()).toBe("");
  expect(input.listenerCount("keypress")).toBe(0);
});

test("providers define their own credential fields", async () => {
  const { input, output, text } = terminal();
  const operation = promptCredentials(
    [{ id: "token", label: "Provider token", secret: true }],
    input,
    output,
  );
  await Promise.resolve();
  input.write("secret\r");
  expect((await operation)._unsafeUnwrap()).toEqual({ token: "secret" });
  expect(text()).toBe("Provider token: \n");
});

test("account selection returns the selected index", async () => {
  const { input, output } = terminal();
  const operation = promptChoice(["One", "Two"], input, output);
  await Promise.resolve();
  input.write("2\r");
  expect((await operation)._unsafeUnwrap()).toBe(1);
});

test("Ctrl+C cancels account selection", async () => {
  const { input, output } = terminal();
  const operation = promptChoice(["One", "Two"], input, output);
  await Promise.resolve();
  input.write("\x03");
  expect((await operation)._unsafeUnwrapErr().tag).toBe("cancelled");
});
