import {describe, expect, it} from 'vitest';
import {AcpV2Connection, type AcpClientConnection, type AcpV2ClientConnection} from '../../ACPSessionConnection';
import {CodexEventHandler} from '../../CodexEventHandler';
import {ClientCapabilities} from '../../tool-calls/ClientCapabilities';
import {createTestSessionState} from '../acp-test-utils';
import type {ThreadPredictionResult} from '../../app-server/v2';

for (const version of [1, 2] as const) {
  describe(`prompt suggestions ACP v${version}`, () => {
    function setup(negotiatedVersion?: number) {
      const received: {method: string; params: unknown}[] = [];
      const wire = {notify: async (method: string, params: unknown) => { received.push({method, params}); }, request: async () => { throw new Error('unexpected request'); }};
      const connection = version === 2
        ? new AcpV2Connection(wire as AcpV2ClientConnection).extensionOnlyV1View()
        : wire as AcpClientConnection;
      const caps = {_meta: {lody: {promptSuggestions: {version: negotiatedVersion}}}};
      const state = createTestSessionState({sessionId: 'root', currentTurnId: null,
        clientCapabilities: version === 2 ? ClientCapabilities.fromV2(caps) : ClientCapabilities.from(caps)});
      return {received, handler: new CodexEventHandler(connection, state)};
    }
    it('forwards native outcomes after prompt disposal without changing source identity', async () => {
      const {handler, received} = setup(1);
      await handler.dispose();
      const results: ThreadPredictionResult[] = [{type: 'completed', text: '  next prompt  '}, {type: 'completed', text: null}, {type: 'failed'}];
      for (const result of results) await handler.handleSessionScopedNotification({method: 'thread/prediction/updated', params: {threadId: 'root', sourceTurnId: 'old-turn', result}});
      expect(received).toEqual(results.map(result => ({method: '_lody/session/prompt_suggestion', params: {sessionId: 'root', sourceTurnId: 'old-turn', result}})));
      expect(handler.getFailure()).toBeNull();
    });
    it('does not forward unnegotiated, unknown-version or foreign-session suggestions', async () => {
      for (const version of [undefined, 2, 1]) {
        const {handler, received} = setup(version);
        await handler.handleSessionScopedNotification({method: 'thread/prediction/updated', params: {threadId: version === 1 ? 'foreign' : 'root', sourceTurnId: 'turn', result: {type: 'completed', text: 'next'}}});
        expect(received).toEqual([]);
      }
    });
  });
}
