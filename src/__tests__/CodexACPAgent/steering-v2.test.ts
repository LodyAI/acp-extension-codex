import {afterEach, describe, expect, it, vi} from 'vitest';
import {SESSION_STEERING_METHOD} from '../../AcpExtensions';
import {
    sessionId, connectSession, userMessageItem, itemCompleted, turnStarted,
    turnCompleted, turnFinished, settle, stateUpdates, type PromptSession,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

async function insertPrompt(client: PromptSession) {
    const response = client.sendPrompt([{type: 'text', text: 'Hello'}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!['clientUserMessageId'] as string)));
    await response;
}

const request = {sessionId, steerId: 'core-steer-1', prompt: [{type: 'text', text: 'also do this'}]};

describe('Core acknowledged steering over ACP v2', () => {
    let client: PromptSession;
    afterEach(() => {
        client?.connection.close();
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('preserves the host steer identity and injects into the owned turn without starting another', async () => {
        client = await connectSession();
        await insertPrompt(client);
        const steer = vi.fn(async () => ({turnId: 'turn-1'}));
        client.setCodexResponse('turn/steer', steer);
        await expect(client.request(SESSION_STEERING_METHOD, request)).resolves.toEqual({outcome: 'injected'});
        expect(steer).toHaveBeenCalledWith(expect.objectContaining({
            threadId: sessionId, expectedTurnId: 'turn-1', clientUserMessageId: request.steerId,
        }));
        client.emit(itemCompleted(userMessageItem(request.steerId, 'also do this')));
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();
        expect(client.turnStartParams).toHaveLength(1);
        expect(stateUpdates(client.transcript)).toEqual([{state: 'running'}, {state: 'idle', stopReason: 'end_turn'}]);
    });

    it('rejects a missing steer identity before dispatch', async () => {
        client = await connectSession();
        await expect(client.request(SESSION_STEERING_METHOD, {sessionId, prompt: request.prompt})).rejects.toMatchObject({code: -32602});
        expect(client.turnStartParams).toHaveLength(0);
    });

    it('refuses an idle session without silently starting a new turn', async () => {
        client = await connectSession();
        await expect(client.request(SESSION_STEERING_METHOD, request)).rejects.toMatchObject({code: -32600});
        expect(client.turnStartParams).toHaveLength(0);
        expect(stateUpdates(client.transcript)).toEqual([]);
    });

    it('preserves transport ambiguity and does not replay the steer as a prompt', async () => {
        client = await connectSession();
        await insertPrompt(client);
        client.setCodexResponse('turn/steer', async () => {throw new Error('transport interrupted');});
        await expect(client.request(SESSION_STEERING_METHOD, request)).rejects.toMatchObject({code: -32603});
        expect(client.turnStartParams).toHaveLength(1);
        client.emit(turnFinished('interrupted'));
        await client.promptRunFinished();
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([{state: 'running'}, {state: 'idle', stopReason: 'cancelled'}]);
    });

    it('lets the host submit a normal prompt after proven non-delivery', async () => {
        client = await connectSession();
        await expect(client.request(SESSION_STEERING_METHOD, request)).rejects.toMatchObject({code: -32600});
        await insertPrompt(client);
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();
        expect(client.turnStartParams).toHaveLength(1);
    });
});
