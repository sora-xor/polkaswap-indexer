import { GraphQLError, getOperationAST, parse } from 'graphql';
import { WebSocket, WebSocketServer } from 'ws';

import { boundGraphQLExecutionResult } from './result-size.js';

import type {
  DocumentNode,
  ExecutionResult,
  GraphQLFormattedError,
  GraphQLSchema,
  SubscriptionArgs,
} from 'graphql';
import type { IncomingMessage } from 'node:http';

export const LEGACY_GRAPHQL_WS_PROTOCOL = 'graphql-ws';

type LegacyClientMessage = {
  id?: unknown;
  type?: unknown;
  payload?: unknown;
};

type LegacyStartPayload = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

type LegacyOperation = {
  cancelled: boolean;
  iterator: AsyncIterator<ExecutionResult> | null;
  releaseBudget: () => void;
};

type LegacyConnection = {
  socket: WebSocket;
  request: IncomingMessage;
  initialized: boolean;
  closed: boolean;
  contextValue: unknown;
  operations: Map<string, LegacyOperation>;
  initTimer: ReturnType<typeof setTimeout>;
  messageChain: Promise<void>;
  pendingMessages: number;
};

export type LegacyGraphqlWebSocketOptions = {
  schema: GraphQLSchema;
  validate: (document: DocumentNode) => readonly GraphQLError[];
  subscribe: (
    args: SubscriptionArgs
  ) => AsyncIterable<ExecutionResult> | Promise<AsyncIterable<ExecutionResult> | ExecutionResult> | ExecutionResult;
  connectionInitWaitTimeoutMs: number;
  maxOperationsPerConnection: number;
  maxPendingMessagesPerConnection: number;
  maxResultBytes: number;
  acquireOperation?: (operation: object) => boolean | GraphQLError;
  releaseOperation?: (operation: object) => void;
  context: (request: IncomingMessage, connectionParams: Record<string, unknown>) => unknown | Promise<unknown>;
};

export type LegacyGraphqlWebSocketHandle = {
  dispose(): Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isAsyncIterable = (value: unknown): value is AsyncIterable<ExecutionResult> =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';

const formattedError = (error: unknown): GraphQLFormattedError => {
  if (error instanceof GraphQLError) return error.toJSON();
  if (error instanceof Error) return { message: error.message || error.name };
  return { message: 'Unknown GraphQL subscription error' };
};

const sendMessage = (
  socket: WebSocket,
  message: { id?: string; type: string; payload?: unknown }
): Promise<void> => {
  if (socket.readyState !== WebSocket.OPEN) return Promise.resolve();

  let encoded: string;
  try {
    encoded = JSON.stringify(message);
  } catch {
    socket.close(1011, 'Unable to serialize GraphQL result');
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    socket.send(encoded, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};

const sendOperationError = (socket: WebSocket, id: string, errors: readonly unknown[]): Promise<void> =>
  sendMessage(socket, {
    id,
    type: 'error',
    payload: errors.map(formattedError),
  });

const parseStartPayload = (value: unknown): LegacyStartPayload => {
  if (!isRecord(value) || typeof value.query !== 'string' || value.query.trim() === '') {
    throw new Error('GraphQL start payload must contain a non-empty query string');
  }
  if (value.variables !== undefined && !isRecord(value.variables)) {
    throw new Error('GraphQL start payload variables must be an object');
  }
  if (value.operationName !== undefined && typeof value.operationName !== 'string') {
    throw new Error('GraphQL start payload operationName must be a string');
  }

  return {
    query: value.query,
    variables: value.variables as Record<string, unknown> | undefined,
    operationName: value.operationName as string | undefined,
  };
};

const stopOperation = async (connection: LegacyConnection, id: string): Promise<void> => {
  const operation = connection.operations.get(id);
  if (!operation) return;
  connection.operations.delete(id);
  operation.cancelled = true;
  operation.releaseBudget();

  try {
    await operation.iterator?.return?.();
  } catch {
    // The client has already stopped the operation. Iterator cleanup errors
    // must not keep the connection or process alive.
  }
};

const closeConnection = async (connection: LegacyConnection): Promise<void> => {
  if (connection.closed) return;
  connection.closed = true;
  clearTimeout(connection.initTimer);
  const operations = [...connection.operations.keys()];
  await Promise.allSettled(operations.map((id) => stopOperation(connection, id)));
};

const operationId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error('GraphQL operation id must be a non-empty string of at most 256 characters');
  }
  return value;
};

const executeOperation = async (
  connection: LegacyConnection,
  id: string,
  payload: LegacyStartPayload,
  document: DocumentNode,
  options: LegacyGraphqlWebSocketOptions,
  operation: LegacyOperation
): Promise<void> => {
  let completedNaturally = false;
  try {
    const result = await options.subscribe({
      schema: options.schema,
      document,
      contextValue: connection.contextValue,
      variableValues: payload.variables,
      operationName: payload.operationName,
    });

    if (!isAsyncIterable(result)) {
      if (!operation.cancelled) {
        await sendMessage(connection.socket, {
          id,
          type: 'data',
          payload: boundGraphQLExecutionResult(result, options.maxResultBytes),
        });
      }
      completedNaturally = true;
      return;
    }

    operation.iterator = result[Symbol.asyncIterator]();
    if (operation.cancelled) {
      await operation.iterator.return?.();
      return;
    }

    while (!operation.cancelled) {
      const next = await operation.iterator.next();
      if (next.done) {
        completedNaturally = true;
        break;
      }
      if (operation.cancelled) break;
      await sendMessage(connection.socket, {
        id,
        type: 'data',
        payload: boundGraphQLExecutionResult(next.value, options.maxResultBytes),
      });
    }
  } catch (error) {
    if (!operation.cancelled) await sendOperationError(connection.socket, id, [error]).catch(() => undefined);
  } finally {
    // Closing the iterator also resumes an emission-scoped subscription that
    // is suspended at `yield`, releasing its memory reservation after send
    // failures and cancellation races.
    await operation.iterator?.return?.().catch(() => undefined);
    if (connection.operations.get(id) === operation) connection.operations.delete(id);
    operation.releaseBudget();
    if (!operation.cancelled && completedNaturally) {
      await sendMessage(connection.socket, { id, type: 'complete', payload: null }).catch(() => undefined);
    }
  }
};

const startOperation = async (
  connection: LegacyConnection,
  message: LegacyClientMessage,
  options: LegacyGraphqlWebSocketOptions
): Promise<void> => {
  const id = operationId(message.id);
  if (!connection.initialized) {
    await sendOperationError(connection.socket, id, [new Error('GraphQL connection has not been initialized')]);
    return;
  }

  if (connection.operations.has(id)) await stopOperation(connection, id);
  if (connection.operations.size >= options.maxOperationsPerConnection) {
    await sendOperationError(connection.socket, id, [
      new Error(`WebSocket connection exceeds the ${options.maxOperationsPerConnection} operation limit.`),
    ]);
    return;
  }

  let payload: LegacyStartPayload;
  let document: DocumentNode;
  try {
    payload = parseStartPayload(message.payload);
    document = parse(payload.query);
  } catch (error) {
    await sendOperationError(connection.socket, id, [error]);
    return;
  }

  const validationErrors = options.validate(document);
  if (validationErrors.length) {
    await sendOperationError(connection.socket, id, validationErrors);
    return;
  }
  const selectedOperation = getOperationAST(document, payload.operationName);
  if (!selectedOperation) {
    await sendOperationError(connection.socket, id, [new Error('GraphQL operation is missing or ambiguous')]);
    return;
  }
  if (selectedOperation.operation !== 'subscription') {
    await sendOperationError(connection.socket, id, [new Error('Only GraphQL subscriptions are accepted over WebSocket')]);
    return;
  }

  let budgetReleased = false;
  const operation: LegacyOperation = {
    cancelled: false,
    iterator: null,
    releaseBudget: () => {
      if (budgetReleased) return;
      budgetReleased = true;
      options.releaseOperation?.(operation);
    },
  };
  if (options.acquireOperation) {
    const admission = options.acquireOperation(operation);
    if (admission !== true) {
      budgetReleased = true;
      await sendOperationError(connection.socket, id, [
        admission instanceof GraphQLError
          ? admission
          : new Error('WebSocket server is at its global operation limit.'),
      ]);
      return;
    }
  }
  connection.operations.set(id, operation);
  void executeOperation(connection, id, payload, document, options, operation);
};

const processMessage = async (
  connection: LegacyConnection,
  raw: WebSocket.RawData,
  options: LegacyGraphqlWebSocketOptions
): Promise<void> => {
  if (connection.closed) return;

  let message: LegacyClientMessage;
  try {
    const decoded: unknown = JSON.parse(raw.toString());
    if (!isRecord(decoded)) throw new Error('Expected a JSON object');
    message = decoded;
  } catch (error) {
    await sendMessage(connection.socket, {
      type: 'connection_error',
      payload: formattedError(error),
    });
    return;
  }

  if (message.type === 'connection_init') {
    if (connection.initialized) {
      await sendMessage(connection.socket, {
        type: 'connection_error',
        payload: { message: 'GraphQL connection is already initialized' },
      });
      connection.socket.close(4429, 'Too many initialisation requests');
      return;
    }
    if (message.payload !== undefined && message.payload !== null && !isRecord(message.payload)) {
      await sendMessage(connection.socket, {
        type: 'connection_error',
        payload: { message: 'GraphQL connection parameters must be an object' },
      });
      connection.socket.close(4400, 'Invalid connection parameters');
      return;
    }

    try {
      connection.contextValue = await options.context(connection.request, (message.payload ?? {}) as Record<string, unknown>);
      connection.initialized = true;
      clearTimeout(connection.initTimer);
      await sendMessage(connection.socket, { type: 'connection_ack' });
    } catch (error) {
      await sendMessage(connection.socket, { type: 'connection_error', payload: formattedError(error) });
      connection.socket.close(1011, 'GraphQL connection initialization failed');
    }
    return;
  }

  if (message.type === 'start') {
    await startOperation(connection, message, options);
    return;
  }
  if (message.type === 'stop') {
    try {
      await stopOperation(connection, operationId(message.id));
    } catch (error) {
      await sendMessage(connection.socket, { type: 'connection_error', payload: formattedError(error) });
    }
    return;
  }
  if (message.type === 'connection_terminate') {
    connection.socket.close(1000, 'Normal closure');
    return;
  }

  await sendMessage(connection.socket, {
    id: typeof message.id === 'string' ? message.id : undefined,
    type: 'error',
    payload: [{ message: 'Unsupported legacy GraphQL WebSocket message type' }],
  });
};

/**
 * Isolated compatibility adapter for the official wallet's legacy
 * `graphql-ws` framing. The maintained `graphql-ws` server remains the
 * preferred transport; this adapter deliberately implements only bounded
 * subscription operations and has no dependency on the abandoned
 * `subscriptions-transport-ws` package.
 */
export const useLegacyGraphqlWebSocketServer = (
  options: LegacyGraphqlWebSocketOptions,
  server: WebSocketServer
): LegacyGraphqlWebSocketHandle => {
  const connections = new Set<LegacyConnection>();
  const onConnection = (socket: WebSocket, request: IncomingMessage): void => {
    if (socket.protocol !== LEGACY_GRAPHQL_WS_PROTOCOL) {
      socket.close(1002, 'Unsupported WebSocket subprotocol');
      return;
    }

    const connection = {} as LegacyConnection;
    Object.assign(connection, {
      socket,
      request,
      initialized: false,
      closed: false,
      contextValue: undefined,
      operations: new Map<string, LegacyOperation>(),
      messageChain: Promise.resolve(),
      pendingMessages: 0,
      initTimer: setTimeout(() => {
        socket.close(4408, 'Connection initialisation timeout');
      }, options.connectionInitWaitTimeoutMs),
    });
    connection.initTimer.unref?.();
    connections.add(connection);

    socket.on('message', (raw) => {
      if (connection.closed) return;
      if (connection.pendingMessages >= options.maxPendingMessagesPerConnection) {
        socket.close(4429, 'Too many pending WebSocket messages');
        void closeConnection(connection);
        return;
      }
      connection.pendingMessages += 1;
      connection.messageChain = connection.messageChain
        .then(() => processMessage(connection, raw, options))
        .catch((error: unknown) => {
          console.error('Legacy GraphQL WebSocket processing failed', error);
          socket.close(1011, 'Legacy GraphQL WebSocket processing failed');
        })
        .finally(() => {
          connection.pendingMessages -= 1;
        });
    });
    socket.once('close', () => {
      connections.delete(connection);
      void closeConnection(connection);
    });
    socket.once('error', () => {
      void closeConnection(connection);
    });
  };

  server.on('connection', onConnection);
  return {
    async dispose(): Promise<void> {
      server.off('connection', onConnection);
      await Promise.allSettled([...connections].map(closeConnection));
      connections.clear();
    },
  };
};
