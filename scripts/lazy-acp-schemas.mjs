import { parse } from "acorn";
import { readFile } from "node:fs/promises";
import path from "node:path";

const validatorName = /^z[A-Z][A-Za-z0-9_]*$/;
const generatedSchemaPath =
  /[/\\]@agentclientprotocol[/\\]sdk[/\\]dist[/\\]v[12][/\\]unstable[/\\]schema[/\\]zod\.gen\.js$/;

function parseModule(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

function visit(node, callback) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, callback);
    } else if (value && typeof value === "object") {
      visit(value, callback);
    }
  }
}

function memberName(member) {
  if (!member.computed && member.property.type === "Identifier")
    return member.property.name;
  if (member.computed && typeof member.property.value === "string")
    return member.property.value;
  return undefined;
}

export function nesValidators(source) {
  const module = parseModule(source);
  const imported = module.body.find(
    (node) =>
      node.type === "ImportDeclaration" &&
      node.source.value.endsWith("/v1/unstable/schema/zod.gen.js"),
  );
  if (!imported) throw new Error("Cannot find the ACP NES validator import");

  const roots = new Set();
  const namespaces = new Set();
  for (const specifier of imported.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier")
      namespaces.add(specifier.local.name);
    if (specifier.type === "ImportSpecifier")
      roots.add(specifier.imported.name);
  }
  visit(module, (node) => {
    if (
      node.type !== "MemberExpression" ||
      node.object.type !== "Identifier" ||
      !namespaces.has(node.object.name)
    )
      return;
    const name = memberName(node);
    if (!name) throw new Error("Cannot resolve a computed ACP NES validator");
    if (validatorName.test(name)) roots.add(name);
  });
  return roots;
}

export function deferSchemas(source, eagerRoots = new Set()) {
  const module = parseModule(source);
  const zodImport = module.body.find(
    (node) =>
      node.type === "ImportDeclaration" && node.source.value === "zod/v4",
  );
  const zod = zodImport?.specifiers.find(
    (specifier) => specifier.type === "ImportNamespaceSpecifier",
  )?.local.name;
  if (!zod) throw new Error("Cannot find the ACP generated Zod namespace");

  const schemas = new Map();
  for (const node of module.body) {
    if (
      node.type !== "ExportNamedDeclaration" ||
      node.declaration?.type !== "VariableDeclaration"
    )
      continue;
    for (const declaration of node.declaration.declarations) {
      if (
        declaration.id.type === "Identifier" &&
        validatorName.test(declaration.id.name) &&
        declaration.init
      ) {
        schemas.set(declaration.id.name, declaration.init);
      }
    }
  }
  if (schemas.size === 0)
    throw new Error("Cannot find ACP generated validators");

  const eager = new Set(eagerRoots);
  const pending = [...eager];
  while (pending.length) {
    const name = pending.pop();
    const initializer = schemas.get(name);
    if (!initializer) throw new Error(`Cannot find ACP validator ${name}`);
    visit(initializer, (node) => {
      if (
        node.type === "Identifier" &&
        schemas.has(node.name) &&
        !eager.has(node.name)
      ) {
        eager.add(node.name);
        pending.push(node.name);
      }
    });
  }

  let result = source;
  const deferred = [...schemas]
    .filter(([name]) => !eager.has(name))
    .map(([, initializer]) => initializer);
  for (const initializer of deferred.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, initializer.start) +
      `${zod}.lazy(() => (` +
      result.slice(initializer.start, initializer.end) +
      "))" +
      result.slice(initializer.end);
  }
  return result;
}

export function lazyAcpSchemas() {
  return {
    name: "lazy-acp-schemas",
    setup(build) {
      build.onLoad({ filter: generatedSchemaPath }, async ({ path: file }) => {
        const directory = path.dirname(file);
        const packageRoot = path.resolve(directory, "../../../..");
        const sdk = JSON.parse(
          await readFile(path.join(packageRoot, "package.json"), "utf8"),
        );
        if (sdk.version !== "2.0.2") return;

        const source = await readFile(file, "utf8");
        const isV1 = file.replaceAll("\\", "/").includes("/dist/v1/");
        const roots = isV1
          ? nesValidators(
              await readFile(path.join(packageRoot, "dist/nes/acp.js"), "utf8"),
            )
          : new Set();
        return { contents: deferSchemas(source, roots), loader: "js" };
      });
    },
  };
}
