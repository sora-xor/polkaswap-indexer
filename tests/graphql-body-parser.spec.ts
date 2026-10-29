import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { createBoundedGraphqlBodyPlugin, createGraphqlSecurityRule } from '../src/graphql/security.js';

function parser(maximum = 64) {
  let parseBody!: (request: Request) => Promise<unknown>;
  createBoundedGraphqlBodyPlugin(maximum).onRequestParse({
    request: { method: 'POST' }, fetchAPI: { Response },
    setRequestParser: (value: typeof parseBody) => { parseBody = value; },
  });
  return parseBody;
}
const request = (body: BodyInit | null, headers: HeadersInit = {}) => new Request('http://localhost/graphql', {
  method: 'POST', body, headers: { 'content-type': 'application/json', ...headers }, duplex: 'half',
} as RequestInit);
async function rejected(value: unknown, status: number, message: string) {
  expect(value).toBeInstanceOf(Response);
  const response = value as Response;
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ errors: [{ message }] });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
}

describe('bounded GraphQL body parser', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT'])('leaves %s requests to the HTTP transport', method => {
    const setRequestParser = vi.fn();
    createBoundedGraphqlBodyPlugin(64).onRequestParse({ request: { method }, setRequestParser, fetchAPI: { Response } });
    expect(setRequestParser).not.toHaveBeenCalled();
  });
  it('preserves query variables and operation names', async () => {
    const body = { query: 'query A { id }', variables: { id: 'abc' }, operationName: 'A' };
    expect(await parser(256)(request(JSON.stringify(body)))).toEqual(body);
  });
  it('accepts an exact byte limit with canonical length and identity encoding', async () => {
    const body = '{"query":"{ id }"}';
    expect(await parser(Buffer.byteLength(body))(request(body, { 'content-length': String(Buffer.byteLength(body)), 'content-encoding': 'identity' }))).toEqual({ query: '{ id }' });
  });
  it.each(['65', '-1', '01', '1.0', '+1', '1e1', 'NaN', 'Infinity', '999999999999999999999999'])('rejects invalid or oversized content length %s before reading', async length => {
    const body = request('{"query":"{id}"}', { 'content-length': length });
    await rejected(await parser()(body), 413, 'Payload too large.');
    expect(body.bodyUsed).toBe(false);
  });
  it.each(['gzip', 'br', 'Identity', 'deflate'])('rejects unsupported %s content encoding', async encoding => {
    await rejected(await parser()(request('{}', { 'content-encoding': encoding })), 415, 'Unsupported content encoding.');
  });
  it.each(['text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded', ''])('rejects unsupported media type %s', async type => {
    await rejected(await parser()(request('{}', { 'content-type': type })), 415, 'Unsupported media type.');
  });
  it('rejects a body without a media type', async () => {
    const req = request(null); req.headers.delete('content-type');
    await rejected(await parser()(req), 415, 'Unsupported media type.');
  });
  it('normalizes media types with case and parameters', async () => {
    expect(await parser()(request('{}', { 'content-type': 'Application/JSON; charset=utf-8' }))).toEqual({});
  });
  it('joins chunk boundaries through a multibyte UTF-8 character', async () => {
    const bytes = new TextEncoder().encode('{"query":"世界"}');
    const stream = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    expect(await parser(bytes.length)(request(stream))).toEqual({ query: '世界' });
  });
  it('cancels an oversized streamed body even when cancellation rejects', async () => {
    const cancel = vi.fn(() => Promise.reject(new Error('stream teardown failed')));
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65)); }, cancel });
    await rejected(await parser()(request(stream)), 413, 'Payload too large.');
    expect(cancel).toHaveBeenCalledWith('payload too large');
  });
  it('counts UTF-8 bytes rather than characters', async () => {
    await rejected(await parser(5)(request('世界', { 'content-type': 'application/graphql' })), 413, 'Payload too large.');
  });
  it('rejects invalid UTF-8 instead of substituting replacement characters', async () => {
    await rejected(await parser()(request(new Uint8Array([0xc3, 0x28]))), 400, 'Invalid UTF-8 body.');
  });
  it('accepts raw GraphQL and preserves its whitespace', async () => {
    expect(await parser()(request('  { id }\n', { 'content-type': 'application/graphql' }))).toEqual({ query: '  { id }\n' });
  });
  it.each(['', ' \n\t'])('rejects a blank raw GraphQL body', async body => {
    await rejected(await parser()(request(body, { 'content-type': 'application/graphql' })), 400, 'Invalid GraphQL request body.');
  });
  it.each([null, '', '{', '{"query":'])('rejects missing or malformed JSON', async body => {
    await rejected(await parser()(request(body)), 400, 'Invalid JSON body.');
  });
  it.each(['[]', '[{"query":"{id}"}]'])('rejects JSON batching', async body => {
    await rejected(await parser()(request(body)), 400, 'GraphQL batching is disabled.');
  });
  it.each(['null', 'false', 'true', '0', '42', '"query"'])('rejects a primitive JSON request: %s', async body => {
    await rejected(await parser()(request(body)), 400, 'Invalid GraphQL request body.');
  });
});

describe('GraphQL security validation rule', () => {
  const schema = buildSchema('type Query { child: Query, id: ID }');
  const limits = { maxDepth: 2, maxFields: 4, maxAliases: 1, allowIntrospection: false };
  it('reports structured errors through the real validation context', () => {
    const errors = validate(schema, parse('{ a: child { child { id } } b: id __schema { queryType { name } } }'), [createGraphqlSecurityRule(limits)]);
    expect(errors.map(error => error.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('depth exceeds'), expect.stringContaining('field count exceeds'), expect.stringContaining('alias count exceeds'),
    ]));
    for (const error of errors) expect(error.extensions).toEqual({ code: 'GRAPHQL_VALIDATION_FAILED', http: { status: 400 } });
  });
  it('counts inline fragments at their containing depth and skips missing fragments', () => {
    expect(validate(schema, parse('{ child { ... on Query { id } ...Missing } }'), [createGraphqlSecurityRule(limits)])).toEqual([]);
  });
  it('allows explicitly enabled introspection', () => {
    expect(validate(schema, parse('{ __schema { queryType { name } } }'), [createGraphqlSecurityRule({ ...limits, maxDepth: 3, allowIntrospection: true })])).toEqual([]);
  });
});
