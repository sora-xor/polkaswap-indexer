import { EventEmitter } from 'node:events';
import { buildSchema, GraphQLError } from 'graphql';
import type { IncomingMessage } from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLegacyGraphqlWebSocketServer, type LegacyGraphqlWebSocketOptions } from '../src/graphql/legacy-websocket.js';
class Socket extends EventEmitter {
  protocol = 'graphql-ws'; readyState: number = WebSocket.OPEN; sent: any[] = []; closes: any[] = []; sendError?: Error;
  send(message: string, callback: (error?: Error) => void) { this.sent.push(JSON.parse(message)); callback(this.sendError); }
  close(code: number, reason: string) { this.closes.push([code, reason]); this.readyState = WebSocket.CLOSED; this.emit('close'); }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const handles: Array<ReturnType<typeof useLegacyGraphqlWebSocketServer>> = [];
const fixture = (overrides: Partial<LegacyGraphqlWebSocketOptions> = {}, protocol = 'graphql-ws') => {
  const server = new EventEmitter(), socket = new Socket(); socket.protocol = protocol;
  const subscribe = vi.fn(async () => ({ data: { tick: 7 } })), release = vi.fn();
  const options: LegacyGraphqlWebSocketOptions = { schema: buildSchema('type Query { value: Int } type Subscription { tick: Int }'), validate: () => [], subscribe, context: async () => ({ user: 'fixture' }), connectionInitWaitTimeoutMs: 10000, maxOperationsPerConnection: 2, maxPendingMessagesPerConnection: 64, maxResultBytes: 10000, releaseOperation: release, ...overrides };
  handles.push(useLegacyGraphqlWebSocketServer(options, server as unknown as WebSocketServer));
  server.emit('connection', socket, {} as IncomingMessage);
  const initialize = async () => { socket.message({ type: 'connection_init' }); await flush(); };
  const start = async (payload: unknown = { query: 'subscription { tick }' }, id: unknown = 'a') => { socket.message({ type: 'start', id, payload }); await flush(); };
  return { socket, server, options, subscribe, release, initialize, start };
};
afterEach(async () => { for (const handle of handles.splice(0)) await handle.dispose(); vi.restoreAllMocks(); });

describe('legacy websocket framing and operation admission', () => {
  it('rejects an incompatible protocol before initializing a connection', () => {
    const f = fixture({}, 'graphql-transport-ws'); expect(f.socket.closes).toEqual([[1002, 'Unsupported WebSocket subprotocol']]);
  });
  it('does not execute an operation before connection initialization', async () => {
    const f = fixture(); await f.start(); expect(f.socket.sent).toMatchObject([{ id: 'a', type: 'error', payload: [{ message: 'GraphQL connection has not been initialized' }] }]); expect(f.subscribe).not.toHaveBeenCalled();
  });
  it.each([null, [], 4, 'text'])('rejects a non-object JSON message %j', async message => {
    const f = fixture(); f.socket.message(message); await flush(); expect(f.socket.sent[0]).toMatchObject({ type: 'connection_error', payload: { message: 'Expected a JSON object' } });
  });
  it.each([[], 'token', 42])('rejects invalid connection parameters %j', async payload => {
    const f = fixture(); f.socket.message({ type: 'connection_init', payload }); await flush(); expect(f.socket.closes).toEqual([[4400, 'Invalid connection parameters']]);
  });
  it('rejects repeated initialization and closes the existing connection', async () => {
    const f = fixture(); await f.initialize(); await f.initialize(); expect(f.socket.closes).toEqual([[4429, 'Too many initialisation requests']]);
  });
  it.each([undefined, '', 42, 'a'.repeat(257)])('rejects invalid operation id %#', async id => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fixture(); await f.initialize(); f.socket.message({ type: 'start', id, payload: { query: 'subscription { tick }' } }); await flush();
    expect(f.socket.closes).toEqual([[1011, 'Legacy GraphQL WebSocket processing failed']]); expect(f.subscribe).not.toHaveBeenCalled();
  });
  it.each([null, {}, { query: ' ' }, { query: 4 }, { query: 'subscription { tick }', variables: [] }, { query: 'subscription { tick }', operationName: 3 }])('rejects malformed start payload %j without acquiring a subscription', async payload => {
    const f = fixture(); await f.initialize(); await f.start(payload); expect(f.socket.sent.at(-1).type).toBe('error'); expect(f.subscribe).not.toHaveBeenCalled();
  });
  it('returns schema validation errors without executing', async () => {
    const f = fixture({ validate: () => [new GraphQLError('invalid field', { extensions: { code: 'BAD_FIELD' } })] }); await f.initialize(); await f.start();
    expect(f.socket.sent.at(-1)).toMatchObject({ type: 'error', payload: [{ message: 'invalid field', extensions: { code: 'BAD_FIELD' } }] }); expect(f.subscribe).not.toHaveBeenCalled();
  });
  it('rejects ambiguous operation selection', async () => {
    const f = fixture(); await f.initialize(); await f.start({ query: 'subscription A { tick } subscription B { tick }' }); expect(f.socket.sent.at(-1).payload[0].message).toMatch(/missing or ambiguous/);
  });
  it('forwards an operation admission error unchanged', async () => {
    const f = fixture({ admitOperation: () => new GraphQLError('rate limited', { extensions: { code: 'RATE_LIMITED' } }) }); await f.initialize(); await f.start();
    expect(f.socket.sent.at(-1)).toMatchObject({ payload: [{ message: 'rate limited', extensions: { code: 'RATE_LIMITED' } }] }); expect(f.subscribe).not.toHaveBeenCalled();
  });
  it.each([false, new GraphQLError('memory budget', { extensions: { code: 'MEMORY' } })])('rejects exhausted operation budgets %#', async admission => {
    const f = fixture({ acquireOperation: () => admission }); await f.initialize(); await f.start(); expect(f.subscribe).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled(); expect(f.socket.sent.at(-1).type).toBe('error');
  });
  it('sends one immediate execution result and completion, releasing exactly once', async () => {
    const f = fixture(); await f.initialize(); await f.start();
    expect(f.socket.sent).toEqual([{ type: 'connection_ack' }, { id: 'a', type: 'data', payload: { data: { tick: 7 } } }, { id: 'a', type: 'complete', payload: null }]); expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([new Error(''), 'unknown'])('formats unusual execution errors %# without exposing arbitrary values', async error => {
    const f = fixture({ subscribe: async () => { throw error; } }); await f.initialize(); await f.start();
    expect(f.socket.sent.at(-1)).toMatchObject({ type: 'error', payload: [{ message: error instanceof Error ? 'Error' : 'Unknown GraphQL subscription error' }] });
  });
  it.each(['client-id', undefined])('rejects unknown message types and preserves bounded correlation ids %#', async id => {
    const f = fixture(); f.socket.message({ type: 'unknown', id }); await flush(); expect(f.socket.sent[0]).toMatchObject({ type: 'error', payload: [{ message: 'Unsupported legacy GraphQL WebSocket message type' }] }); expect(f.socket.sent[0].id).toBe(id);
  });
  it('ignores stopping a missing operation and honors normal termination', async () => {
    const f = fixture(); await f.initialize(); f.socket.message({ type: 'stop', id: 'absent' }); await flush(); expect(f.release).not.toHaveBeenCalled(); f.socket.message({ type: 'connection_terminate' }); await flush(); expect(f.socket.closes).toEqual([[1000, 'Normal closure']]);
  });
});

describe('legacy websocket cancellation races', () => {
  it('does not publish a late immediate result after cancellation', async () => {
    let complete!: (value: any) => void;
    const f = fixture({ subscribe: () => new Promise(resolve => { complete = resolve; }) }); await f.initialize(); await f.start();
    f.socket.message({ type: 'stop', id: 'a' }); await flush(); complete({ data: { tick: 1 } }); await flush();
    expect(f.socket.sent).toEqual([{ type: 'connection_ack' }]); expect(f.release).toHaveBeenCalledOnce();
  });
  it('closes an iterator returned after cancellation without requesting a row', async () => {
    let complete!: (value: any) => void; const iterator = { next: vi.fn(), return: vi.fn(async () => ({ done: true as const, value: undefined })) };
    const f = fixture({ subscribe: () => new Promise(resolve => { complete = resolve; }) }); await f.initialize(); await f.start(); f.socket.message({ type: 'stop', id: 'a' }); await flush();
    complete({ [Symbol.asyncIterator]: () => iterator }); await flush(); expect(iterator.next).not.toHaveBeenCalled(); expect(iterator.return).toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
  it('drops an iterator row resolved after cancellation', async () => {
    let next!: (value: any) => void;
    const iterator = { next: () => new Promise(resolve => { next = resolve; }), return: vi.fn(async () => ({ done: true as const, value: undefined })) };
    const f = fixture({ subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }) as any }); await f.initialize(); await f.start(); f.socket.message({ type: 'stop', id: 'a' }); await flush(); next({ done: false, value: { data: { tick: 2 } } }); await flush();
    expect(f.socket.sent).toEqual([{ type: 'connection_ack' }]); expect(f.release).toHaveBeenCalledOnce();
  });
  it('replaces an operation id by cancelling its previous subscription first', async () => {
    const returns = vi.fn(async () => ({ done: true as const, value: undefined }));
    const f = fixture({ subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined), return: returns }) }) });
    await f.initialize(); await f.start(); await f.start(); expect(returns).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  });
  it('avoids sending to a socket that closes during subscription resolution', async () => {
    let complete!: (value: any) => void; const f = fixture({ subscribe: () => new Promise(resolve => { complete = resolve; }) }); await f.initialize(); await f.start();
    f.socket.readyState = WebSocket.CLOSED; complete({ data: { tick: 3 } }); await flush(); expect(f.socket.sent).toEqual([{ type: 'connection_ack' }]); expect(f.release).toHaveBeenCalledOnce();
  });
  it('releases a subscription after a send callback failure', async () => {
    const f = fixture(); await f.initialize(); f.socket.sendError = new Error('closed transport'); await f.start(); expect(f.release).toHaveBeenCalledOnce();
  });
});
