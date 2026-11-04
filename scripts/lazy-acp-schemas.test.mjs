import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, it } from "vitest";
import { deferSchemas, lazyAcpSchemas } from "./lazy-acp-schemas.mjs";

const require = createRequire(import.meta.url);
const v1 = require.resolve("@agentclientprotocol/sdk/unstable");
const v2 = require.resolve("@agentclientprotocol/sdk/experimental/v2/unstable");
const nes = require.resolve("@agentclientprotocol/sdk/experimental/nes");
const schemas = (entry) => path.join(path.dirname(entry), "schema/zod.gen.js");
let directory;

async function bundle(entry, name, optimized) {
  const outfile = path.join(
    directory,
    `${name}-${optimized ? "lazy" : "original"}.mjs`,
  );
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: optimized ? [lazyAcpSchemas()] : [],
  });
  return import(pathToFileURL(outfile).href);
}

function outcome(schema, value) {
  try {
    const result = schema.safeParse(structuredClone(value));
    return result.success
      ? { success: true, data: result.data }
      : {
          success: false,
          issues: result.error.issues,
          message: result.error.message,
        };
  } catch (error) {
    return { thrown: error.name, message: error.message };
  }
}

const inputs = [
  undefined,
  null,
  true,
  false,
  0,
  1,
  -1,
  "",
  "session-1",
  [],
  [1],
  [{}],
  {},
  {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  {
    protocolVersion: 2,
    info: { name: "test", version: "1" },
    capabilities: {},
  },
  { sessionId: "session-1", cwd: "/tmp/project", mcpServers: [] },
  { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] },
  {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
  },
  {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: "hello" },
    },
  },
  {
    sessionId: "session-1",
    title: "Read file",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  },
  { sessionId: "session-1", path: "/tmp/project/file" },
  { type: "text", text: "hello", _meta: {} },
  { type: "image", data: "YWJj", mimeType: "image/png" },
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { unexpected: "value", _meta: { custom: true } },
];

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "acp-schema-test-"));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("lazy ACP validation schemas", () => {
  it("constructs each deferred schema when it is first used", async () => {
    const source = `
      import * as z from 'zod/v4';
      let count = 0;
      const make = () => { count++; return z.string(); };
      export const zValue = make();
      export function constructions() { return count; }
    `;
    const outfile = path.join(directory, "lazy-fixture.mjs");
    await build({
      stdin: {
        contents: deferSchemas(source),
        resolveDir: process.cwd(),
        loader: "js",
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const fixture = await import(pathToFileURL(outfile).href);
    assert.equal(fixture.constructions(), 0);
    assert.equal(fixture.zValue.parse("hello"), "hello");
    assert.equal(fixture.constructions(), 1);
    assert.equal(fixture.zValue.parse("again"), "again");
    assert.equal(fixture.constructions(), 1);
  });

  for (const [version, entry] of [
    ["v1", v1],
    ["v2", v2],
  ]) {
    it(`preserves ${version} validator results and errors`, async () => {
      const [original, lazy] = await Promise.all([
        bundle(schemas(entry), version, false),
        bundle(schemas(entry), version, true),
      ]);
      assert.deepEqual(Object.keys(lazy).sort(), Object.keys(original).sort());
      assert.notEqual(original.zPromptRequest.type, "lazy");
      assert.equal(lazy.zPromptRequest.type, "lazy");
      for (const name of Object.keys(original)) {
        for (const input of inputs) {
          assert.deepEqual(
            outcome(lazy[name], input),
            outcome(original[name], input),
            `${version}: ${name}`,
          );
        }
      }
    });
  }

  it("preserves the NES exported object schemas and their nested object types", async () => {
    const [original, lazy] = await Promise.all([
      bundle(nes, "nes", false),
      bundle(nes, "nes", true),
    ]);
    for (const name of [
      "zClientCapabilities",
      "zAgentCapabilities",
      "zInitializeRequest",
      "zInitializeResponse",
    ]) {
      assert.equal(typeof lazy[name].extend, "function");
      const originalExtended = original[name].extend({});
      const lazyExtended = lazy[name].extend({});
      for (const input of inputs)
        assert.deepEqual(
          outcome(lazyExtended, input),
          outcome(originalExtended, input),
          name,
        );
    }
    const fsSchema = lazy.zClientCapabilities.shape.fs
      .unwrap()
      .unwrap()
      .unwrap();
    assert.equal(typeof fsSchema.extend, "function");
  });

  it("leaves other SDK versions unchanged", async () => {
    const packageRoot = path.join(
      directory,
      "node_modules/@agentclientprotocol/sdk",
    );
    const schemaDir = path.join(packageRoot, "dist/v2/unstable/schema");
    await mkdir(schemaDir, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ version: "9.0.0" }),
    );
    await writeFile(
      path.join(schemaDir, "zod.gen.js"),
      `
      import * as z from 'zod/v4';
      export const zValue = z.object({value: z.string()});
    `,
    );
    const outfile = path.join(directory, "future-sdk.mjs");
    await build({
      entryPoints: [path.join(schemaDir, "zod.gen.js")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [lazyAcpSchemas()],
      nodePaths: [path.resolve("node_modules")],
    });
    const future = await import(pathToFileURL(outfile).href);
    assert.equal(typeof future.zValue.extend, "function");
    assert.deepEqual(future.zValue.parse({ value: "hello" }), {
      value: "hello",
    });
  });
});
