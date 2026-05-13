import { describe, expect, it } from 'vitest';
import { OAuthError, OAuthFlowManager } from '../oauth.js';

function createManager() {
  const manager = new OAuthFlowManager({} as never, {} as never);
  manager.registerProvider({
    connectorId: 'github',
    authorizationUrl: 'https://auth.example.com/oauth',
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://pilot.example.com/api/connectors/github/oauth/callback',
    defaultScopes: ['repo'],
    supportsPkce: false,
  });
  return manager;
}

describe('OAuthFlowManager callback state inspection', () => {
  it('returns verified callback context without consuming state', () => {
    const manager = createManager();
    const { state } = manager.initiateFlow({
      connectorId: 'github',
      workspaceId: 'ws-1',
    });

    expect(manager.inspectCallbackState(state)).toEqual({
      connectorId: 'github',
      workspaceId: 'ws-1',
    });
    expect(manager.inspectCallbackState(state)).toEqual({
      connectorId: 'github',
      workspaceId: 'ws-1',
    });
  });

  it('rejects unknown callback state', () => {
    const manager = createManager();

    expect(() => manager.inspectCallbackState('unknown-state')).toThrow(OAuthError);
  });
});
