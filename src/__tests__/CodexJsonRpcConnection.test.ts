import {spawn, type ChildProcessWithoutNullStreams, type SpawnOptions} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {startCodexConnection} from '../CodexJsonRpcConnection';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {...actual, spawn: vi.fn(actual.spawn)};
});
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const fixture = "require('node:readline').createInterface({input:process.stdin}).on('line', line => {const request=JSON.parse(line);process.stdout.write(JSON.stringify({id:request.id,result:{args:process.argv.slice(1),home:process.env.CODEX_HOME,token:process.env.LODY_CODEX_PROCESS_TOKEN??null}})+'\\n');});";
const stderrFixture = "process.stderr.write('app-server diagnostic line\\n');" + "require('node:readline').createInterface({input:process.stdin}).on('line', line => {const request=JSON.parse(line);process.stdout.write(JSON.stringify({id:request.id,result:{echo:request.method}})+'\\n');});";

async function spawnStderrFixture(spawnFn: typeof spawn) {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawnFn).mockImplementation(((command: string, argsOrOptions: string[] | SpawnOptions, options?: SpawnOptions) => {
        const opts = (Array.isArray(argsOrOptions) ? options : argsOrOptions)!;
        const child = actual.spawn(process.execPath, ['-e', stderrFixture], {...opts, shell: false, stdio: 'pipe'}) as ChildProcessWithoutNullStreams;
        children.push(child);
        return child;
    }) as typeof spawn);
}

async function processFixture(platform?: 'win32') {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let observed: {command: string; args: string[]; shell: boolean | string | undefined; windowsHide: boolean | undefined} | undefined;
    vi.mocked(spawn).mockImplementation(((command: string, argsOrOptions: string[] | SpawnOptions, options?: SpawnOptions) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        const opts = (Array.isArray(argsOrOptions) ? options : argsOrOptions)!;
        observed = {command, args, shell: opts.shell, windowsHide: opts.windowsHide};
        const child = actual.spawn(process.execPath, ['-e', fixture, '--', ...args], {...opts, shell: false, stdio: 'pipe'}) as ChildProcessWithoutNullStreams;
        children.push(child);
        return child;
    }) as typeof spawn);
    if (platform) vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const root = await mkdtemp(path.join(tmpdir(), 'codex-process-contract-'));
    roots.push(root);
    await mkdir(path.join(root, 'home'));
    await mkdir(path.join(root, 'processes'));
    const token = randomUUID();
    await writeFile(path.join(root, 'processes', token + '.json'), JSON.stringify({version: 1, token}));
    return {root, token, observed: () => observed};
}

describe('startCodexConnection', () => {
    afterEach(async () => {
        for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill(); await exited;
        }
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
    });

    it.each([undefined, 'win32'] as const)('pins native startup values and owns independent process proofs on %s', async platform => {
        const test = await processFixture(platform);
        const env = {
            CODEX_HOME: path.join(test.root, 'home'),
            LODY_CODEX_PROCESS_TOKEN: test.token,
            LODY_CODEX_PROFILE_CONFIG: JSON.stringify({cli_auth_credentials_store: 'keyring', model_provider: 'openai', model_providers: {synthetic: {requires_openai_auth: false}}}),
        };
        const first = startCodexConnection('/synthetic/codex', env);
        const proof = path.join(test.root, 'processes', test.token + '.native.json');
        const result = await first.connection.sendRequest('probe');
        expect(result).toEqual({args: ['-c', 'cli_auth_credentials_store="keyring"', '-c', 'model_provider="openai"', '-c', 'model_providers={"synthetic"={"requires_openai_auth"=false}}', 'app-server'], home: env.CODEX_HOME, token: null});
        expect(test.observed()).toMatchObject({command: '/synthetic/codex', shell: undefined, windowsHide: true});
        expect(env.LODY_CODEX_PROCESS_TOKEN).toBe(test.token);
        expect(JSON.parse(await readFile(proof, 'utf8'))).toEqual({nativePid: first.process.pid, nativeExited: false});
        const secondToken = randomUUID();
        await writeFile(path.join(test.root, 'processes', secondToken + '.json'), JSON.stringify({version: 1, token: secondToken}));
        const second = startCodexConnection('/synthetic/codex', {...env, LODY_CODEX_PROCESS_TOKEN: secondToken});
        await second.connection.sendRequest('probe');
        const exited = once(first.process, 'exit'); first.process.kill(); await exited;
        expect(JSON.parse(await readFile(proof, 'utf8')).nativeExited).toBe(true);
        expect(JSON.parse(await readFile(path.join(test.root, 'processes', secondToken + '.native.json'), 'utf8'))).toEqual({nativePid: second.process.pid, nativeExited: false});
        expect(await second.connection.sendRequest('still-running')).toEqual(result);
    });

    it('preserves legacy Windows shell launch and native home without a profile token', async () => {
        const test = await processFixture('win32');
        const env = {CODEX_HOME: path.join(test.root, 'home')};
        const native = startCodexConnection('C:\\Program Files\\Codex\\codex.cmd', env);
        expect(await native.connection.sendRequest('probe')).toEqual({args: [], home: env.CODEX_HOME, token: null});
        expect(test.observed()).toEqual({command: '"C:\\Program Files\\Codex\\codex.cmd" app-server', args: [], shell: true, windowsHide: true});
    });

    it('forwards live app-server stderr to the adapter stderr while stdout stays protocol-only', async () => {
        await spawnStderrFixture(spawn);
        const forwarded: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            forwarded.push(String(chunk));
            return true;
        }) as typeof process.stderr.write);

        const started = startCodexConnection('/synthetic/codex', {});
        await once(started.process.stderr, 'data');

        expect(forwarded.join('')).toContain('app-server diagnostic line');
        // stderr forwarding must not leak into the JSON-RPC stdout stream.
        expect(await started.connection.sendRequest('probe')).toEqual({echo: 'probe'});
    });

    it('keeps the optional APP_SERVER_LOGS file copy alongside stderr forwarding', async () => {
        const logDir = await mkdtemp(path.join(tmpdir(), 'codex-app-server-logs-'));
        roots.push(logDir);
        vi.stubEnv('APP_SERVER_LOGS', logDir);
        vi.resetModules();
        const {startCodexConnection: startWithFileLogs} = await import('../CodexJsonRpcConnection');
        const freshSpawn = (await import('node:child_process')).spawn;
        await spawnStderrFixture(freshSpawn);
        const forwarded: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            forwarded.push(String(chunk));
            return true;
        }) as typeof process.stderr.write);

        const started = startWithFileLogs('/synthetic/codex', {});
        await once(started.process.stderr, 'data');

        expect(forwarded.join('')).toContain('app-server diagnostic line');
        const fileLog = await readFile(path.join(logDir, 'app-server.log'), 'utf8');
        expect(fileLog).toContain('[ERR] app-server diagnostic line');
        expect(await started.connection.sendRequest('probe')).toEqual({echo: 'probe'});
    });

    it('rejects unowned process tokens before starting native Codex', async () => {
        const test = await processFixture();
        const env = {CODEX_HOME: path.join(test.root, 'home'), LODY_CODEX_PROFILE_CONFIG: '{}', LODY_CODEX_PROCESS_TOKEN: '../foreign'};
        expect(() => startCodexConnection('/synthetic/codex', env)).toThrow('Invalid Codex profile process token');
        expect(test.observed()).toBeUndefined();
        await writeFile(path.join(test.root, 'processes', test.token + '.json'), JSON.stringify({version: 1, token: randomUUID()}));
        expect(() => startCodexConnection('/synthetic/codex', {...env, LODY_CODEX_PROCESS_TOKEN: test.token})).toThrow('Invalid Codex profile process record');
        expect(test.observed()).toBeUndefined();
    });
});
