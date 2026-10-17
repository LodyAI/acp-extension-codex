import {afterEach, describe, expect, it, vi} from 'vitest';
import {SESSION_STEERING_METHOD} from '../../AcpExtensions';
import {
    sessionId,
    connectSession,
    userMessageItem,
    itemStarted,
    itemCompleted,
    turnStarted,
    turnCompleted,
    turnFinished,
    settle,
    stateUpdates,
    dump,
    type PromptSession,
    type TranscriptEntry,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

function userMessageChunks(transcript: TranscriptEntry[]) {
    return transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => update.sessionUpdate === "user_message_chunk");
}

/** Overrides `turn/steer` to capture the minted `clientUserMessageId` it was sent. */
function captureSteerClientId(client: PromptSession): {captured: () => string} {
    let captured: string | null = null;
    client.setCodexResponse("turn/steer", async (params) => {
        captured = (params as {clientUserMessageId: string}).clientUserMessageId;
        return {turnId: (params as {expectedTurnId: string}).expectedTurnId};
    });
    return {
        captured: () => {
            if (captured === null) {
                throw new Error("turn/steer was not called yet");
            }
            return captured;
        },
    };
}

/** Runs a normal prompt to completion, so `v2PromptsInFlight` no longer owns the session. */
async function runPromptToCompletion(client: PromptSession) {
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
    await response;
    client.emit(turnCompleted());
    await client.promptRunFinished();
    await settle();
}

describe('_session/steering over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('shows a live user_message, with no extra states, when a steer injected into a v2-prompt-owned turn lands', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        const steerClientId = captureSteerClientId(client);

        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const promptClientId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(promptClientId)));
        const {messageId} = await response;
        const start = client.transcript.length;

        const steerResult = await client.request(SESSION_STEERING_METHOD, {
            sessionId,
            steerId: "steer-v2",
            prompt: [{type: "text", text: "also do this"}],
        });
        expect(steerResult).toEqual({outcome: "injected"});
        // Acceptance alone and item/started do not prove delivery.
        expect(userMessageChunks(client.transcript.slice(start))).toEqual([]);
        client.emit(itemStarted(userMessageItem(steerClientId.captured(), "also do this")));
        await settle();
        expect(userMessageChunks(client.transcript.slice(start))).toEqual([]);
        client.emit(itemCompleted(userMessageItem(steerClientId.captured(), "also do this")));
        await settle();
        expect(userMessageChunks(client.transcript.slice(start))).toEqual([
            {sessionUpdate: "user_message_chunk", messageId: steerClientId.captured(), content: {type: "text", text: "also do this"}},
        ]);

        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        // Steering an already-owned turn sends no states of its own.
        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        await expect(dump(client.transcript, messageId).replaceAll(steerClientId.captured(), "<steerMessageId>"))
            .toMatchFileSnapshot('data/steering-v2-injected-owned-turn.json');
    });

    it.each([false, true])('refuses a steer without an owned active prompt (native turn: %s)', async (nativeTurn) => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await runPromptToCompletion(client);
        if (nativeTurn) {
            client.emit(turnStarted("turn-2"));
            await settle();
        }
        const starts = client.turnStartParams.length;
        await expect(client.request(SESSION_STEERING_METHOD, {
            sessionId,
            steerId: "steer-v2-refused",
            prompt: [{type: "text", text: "start fresh"}],
        })).rejects.toMatchObject({code: -32600});
        expect(client.turnStartParams).toHaveLength(starts);
        if (nativeTurn) client.emit(turnCompleted("turn-2"));
        await settle();
    });
});
