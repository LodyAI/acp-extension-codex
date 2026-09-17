import {describe, expect, it} from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import {clientSupportsElicitationAnswerNotes} from '../ElicitationCapabilities';

describe('Core answer-note capability negotiation', () => {
    it.each([
        undefined, null, {}, {version: 1}, {version: 2, answerNotes: true},
        {version: '1', answerNotes: true}, {version: 1, answerNotes: false},
        {version: 1, answerNotes: 'true'}, [], true,
    ])('does not enable notes for %j', (elicitation) => {
        expect(clientSupportsElicitationAnswerNotes({
            elicitation: {form: {}},
            _meta: {lody: {elicitation}},
        } as acp.ClientCapabilities)).toBe(false);
    });

    it.each([undefined, null, {}, {elicitation: {form: {}}}, {_meta: {lody: []}}])(
        'handles absent or malformed metadata: %j', (capabilities) => {
            expect(clientSupportsElicitationAnswerNotes(capabilities as acp.ClientCapabilities)).toBe(false);
        },
    );

    it('requires standard form support in addition to the exact Core capability', () => {
        const _meta = {lody: {elicitation: {version: 1, answerNotes: true}}};
        expect(clientSupportsElicitationAnswerNotes({_meta})).toBe(false);
        expect(clientSupportsElicitationAnswerNotes({_meta, elicitation: {url: {}}})).toBe(false);
        expect(clientSupportsElicitationAnswerNotes({_meta, elicitation: {form: {}}})).toBe(true);
    });
});
