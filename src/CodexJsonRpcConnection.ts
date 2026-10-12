import * as rpc from "vscode-jsonrpc/node";
import type {Message} from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import crossSpawn from "cross-spawn";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

const require = createRequire(import.meta.url);

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
    /**
     * Settles once the connection has handled every message that the process wrote before its stdout ended.
     * `CodexAppServerSupervisor` waits for it before it disposes the connection of a dead process.
     */
    readonly drained?: Promise<void>;
}

/** A notification that the adapter feeds into the connection after the last message of the process. */
const DRAINED_MARKER_METHOD = "codex-acp/stdoutDrained";

export interface StartCodexConnectionOptions {
    /**
     * Dispose the connection when the process exits (default). `CodexAppServerSupervisor` turns it off: it disposes
     * the connection itself, after the last output of the process was read.
     */
    disposeOnExit?: boolean;
}

export function startCodexConnection(
    codexPath?: string,
    env?: NodeJS.ProcessEnv,
    appServerStartupArgs: string[] = ["app-server"],
    options: StartCodexConnectionOptions = {},
): CodexConnection {
    const spawnEnv = {...(env ?? process.env)};
    const processToken = spawnEnv['LODY_CODEX_PROCESS_TOKEN'];
    delete spawnEnv['LODY_CODEX_PROCESS_TOKEN'];
    const spawnOptions = {env: spawnEnv, windowsHide: true};
    const managedConfig = spawnEnv['LODY_CODEX_PROFILE_CONFIG'];
    const args = managedConfig ? profileStartupArgs(JSON.parse(managedConfig)) : [];
    args.push(...appServerStartupArgs);
    let nativeProof: string | undefined;
    if (processToken) {
        if (!managedConfig || !spawnEnv['CODEX_HOME'] || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(processToken)) {
            throw new Error('Invalid Codex profile process token');
        }
        const processDirectory = path.join(spawnEnv['CODEX_HOME'], '..', 'processes');
        const record = JSON.parse(readFileSync(path.join(processDirectory, `${processToken}.json`), 'utf8'));
        if (record.version !== 1 || record.token !== processToken) throw new Error('Invalid Codex profile process record');
        nativeProof = path.join(processDirectory, `${processToken}.native.json`);
    }


    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        // cross-spawn runs `.cmd` shims through cmd.exe with correct escaping for the TOML hook override.
        codex = process.platform === "win32"
            ? crossSpawn(codexPath, args, spawnOptions) as ChildProcessWithoutNullStreams
            : spawn(codexPath, args, spawnOptions);
    } else {
        const bundledCodexPath = require.resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...args], spawnOptions);
    }

    attachLogs(codex);
    // A write to a process that is dying fails with EPIPE. Without a listener that error would end the adapter.
    codex.stdin.on("error", (error) => logger.log(`[STDIN ERROR] ${error.message}`));
    codex.stdout.on("error", (error) => logger.log(`[STDOUT ERROR] ${error.message}`));
    const updateProcessProof = (nativeExited: boolean) => {
        if (!nativeProof) return;
        try {
            writeFileSync(nativeProof, JSON.stringify({nativePid: codex.pid, nativeExited}), {mode: 0o600});
        } catch { /* Unknown process state delays host credential cleanup only. */ }
    };
    updateProcessProof(false);
    codex.once('exit', () => updateProcessProof(true));
    codex.once('error', () => {
        if (codex.pid === undefined) updateProcessProof(true);
    });

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // vscode-jsonrpc handles the messages that it read one by one, after the read. The marker comes after the last
    // message of the process, so its handler runs only when every earlier message was handled.
    const drained = new Promise<void>(resolve => {
        connection.onNotification(DRAINED_MARKER_METHOD, () => resolve());
    });
    codex.stdout.on("end", () => reader.deliver?.({jsonrpc: "2.0", method: DRAINED_MARKER_METHOD} as Message));

    if (options.disposeOnExit ?? true) {
        // Terminate all current activities on process termination
        codex.on("exit", _ => {
            connection.dispose();
        });
    }

    return {connection: connection, process: codex, drained};
}

function profileStartupArgs(config: unknown): string[] {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Invalid managed Codex startup configuration');
    }
    const toml = (value: unknown): string => {
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
        if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
        throw new Error('Invalid managed Codex startup value');
    };
    return Object.entries(config).flatMap(([key, value]) => {
        if (!/^[a-z_]+$/.test(key)) throw new Error('Invalid managed Codex startup key');
        return ['-c', `${key}=${toml(value)}`];
    });
}

/**
 * Logs the traffic of the app-server.
 * The listeners stay attached when logging is off, so that stderr keeps draining,
 * but a chunk is turned into a string only when the logger writes it.
 */
export function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        if (logger.enabled) logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        process.stderr.write(data);
        if (logger.enabled) logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        if (logger.enabled) logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
