import * as rpc from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
}

export function startCodexConnection(codexPath?: string, env?: NodeJS.ProcessEnv): CodexConnection {
    const spawnEnv = {...(env ?? process.env)};
    const processToken = spawnEnv['LODY_CODEX_PROCESS_TOKEN'];
    delete spawnEnv['LODY_CODEX_PROCESS_TOKEN'];
    const spawnOptions = {env: spawnEnv, windowsHide: true};
    const managedConfig = spawnEnv['LODY_CODEX_PROFILE_CONFIG'];
    const args = managedConfig ? profileStartupArgs(JSON.parse(managedConfig)) : [];
    args.push('app-server');
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
        codex = process.platform === 'win32' && !managedConfig
            ? spawn(`"${codexPath}" app-server`, {...spawnOptions, shell: true})
            : spawn(codexPath, args, spawnOptions);
    } else {
        const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...args], spawnOptions);
    }

    attachLogs(codex);
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

    // Terminate all current activities on process termination
    codex.on("exit", _ => {
        connection.dispose();
    });

    return {connection: connection, process: codex};
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

function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
