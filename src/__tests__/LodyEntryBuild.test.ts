import {build, type BuildOptions} from "esbuild";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

it("builds the Lody entry without the ACP v2 SDK", async () => {
    const options: BuildOptions = {
        absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
        write: false,
        external: ["@openai/codex"],
        plugins: [{
            name: "unavailable-acp-v2",
            setup(builder) {
                builder.onResolve({filter: /^@agentclientprotocol\/sdk\/experimental\/v2(?:\/|$)/}, args => ({
                    errors: [{text: `Unexpected ACP v2 dependency: ${args.path}`}],
                }));
                builder.onLoad({filter: /[\\/]@agentclientprotocol[\\/]sdk[\\/]dist[\\/]v2[\\/]/}, args => ({
                    errors: [{text: `Unexpected ACP v2 dependency: ${args.path}`}],
                }));
            },
        }],
    };
    const result = await build({...options, entryPoints: ["src/lody.ts"]});
    expect(result.errors).toEqual([]);
    await expect(build({...options, entryPoints: ["src/index.ts"]}))
        .rejects.toThrow("Unexpected ACP v2 dependency");
});
