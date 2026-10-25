import { GraphQLError, type DocumentNode, type SelectionSetNode, type ValidationContext, type ValidationRule } from 'graphql';

export type GraphqlSecurityLimits = {
  maxDepth: number;
  maxFields: number;
  maxAliases: number;
  allowIntrospection: boolean;
};

const validationError = (message: string): GraphQLError =>
  new GraphQLError(message, {
    extensions: { code: 'GRAPHQL_VALIDATION_FAILED', http: { status: 400 } },
  });

export function analyzeGraphqlDocument(document: DocumentNode, limits: GraphqlSecurityLimits): GraphQLError[] {
  const fragments = new Map(
    document.definitions
      .filter((definition) => definition.kind === 'FragmentDefinition')
      .map((definition) => [definition.name.value, definition])
  );
  const errors: GraphQLError[] = [];
  let depthExceeded = false;
  let fieldsExceeded = false;
  let aliasesExceeded = false;
  let introspectionUsed = false;
  let fields = 0;
  let aliases = 0;

  for (const definition of document.definitions) {
    if (definition.kind !== 'OperationDefinition') continue;
    const visitSelections = (selectionSet: SelectionSetNode, depth: number, fragmentStack: ReadonlySet<string>): void => {
      if (fieldsExceeded) return;
      for (const selection of selectionSet.selections) {
        if (selection.kind === 'Field') {
          fields += 1;
          if (fields > limits.maxFields) {
            fieldsExceeded = true;
            return;
          }
          if (selection.alias) {
            aliases += 1;
            if (aliases > limits.maxAliases) aliasesExceeded = true;
          }
          if (selection.name.value === '__schema' || selection.name.value === '__type') introspectionUsed = true;
          if (depth > limits.maxDepth) depthExceeded = true;
          if (selection.selectionSet && !fieldsExceeded) {
            visitSelections(selection.selectionSet, depth + 1, fragmentStack);
          }
          continue;
        }
        if (selection.kind === 'InlineFragment') {
          visitSelections(selection.selectionSet, depth, fragmentStack);
          continue;
        }
        const name = selection.name.value;
        const fragment = fragments.get(name);
        if (!fragment || fragmentStack.has(name)) continue;
        visitSelections(fragment.selectionSet, depth, new Set([...fragmentStack, name]));
      }
    };
    visitSelections(definition.selectionSet, 1, new Set());
  }

  if (depthExceeded) errors.push(validationError(`GraphQL query depth exceeds the maximum of ${limits.maxDepth}.`));
  if (fieldsExceeded) errors.push(validationError(`GraphQL query field count exceeds the maximum of ${limits.maxFields}.`));
  if (aliasesExceeded) errors.push(validationError(`GraphQL query alias count exceeds the maximum of ${limits.maxAliases}.`));
  if (!limits.allowIntrospection && introspectionUsed) {
    errors.push(validationError('GraphQL schema introspection is disabled.'));
  }
  return errors;
}

export function createGraphqlSecurityRule(limits: GraphqlSecurityLimits): ValidationRule {
  return (context: ValidationContext) => ({
    Document(node) {
      for (const error of analyzeGraphqlDocument(node, limits)) context.reportError(error);
      return false;
    },
  });
}

const jsonError = (fetchAPI: { Response: typeof Response }, status: number, message: string): Response =>
  new fetchAPI.Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
    },
  });

async function readBoundedBody(request: Request, maximum: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    length += chunk.byteLength;
    if (length > maximum) {
      await reader.cancel('payload too large').catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Overrides Yoga's POST parser so chunked bodies are bounded before JSON parsing. */
export function createBoundedGraphqlBodyPlugin(maximum: number) {
  return {
    onRequestParse({ request, setRequestParser, fetchAPI }: any) {
      if (request.method !== 'POST') return;
      setRequestParser(async (nextRequest: Request) => {
        const contentLength = nextRequest.headers.get('content-length');
        if (contentLength !== null && (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > maximum)) {
          return jsonError(fetchAPI, 413, 'Payload too large.');
        }
        const encoding = nextRequest.headers.get('content-encoding');
        if (encoding && encoding !== 'identity') return jsonError(fetchAPI, 415, 'Unsupported content encoding.');
        const contentType = nextRequest.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json' && contentType !== 'application/graphql') {
          return jsonError(fetchAPI, 415, 'Unsupported media type.');
        }
        const body = await readBoundedBody(nextRequest, maximum);
        if (body === null) return jsonError(fetchAPI, 413, 'Payload too large.');
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        } catch {
          return jsonError(fetchAPI, 400, 'Invalid UTF-8 body.');
        }
        if (contentType === 'application/graphql') {
          if (!text.trim()) return jsonError(fetchAPI, 400, 'Invalid GraphQL request body.');
          return { query: text };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return jsonError(fetchAPI, 400, 'Invalid JSON body.');
        }
        if (Array.isArray(parsed)) return jsonError(fetchAPI, 400, 'GraphQL batching is disabled.');
        if (!parsed || typeof parsed !== 'object') return jsonError(fetchAPI, 400, 'Invalid GraphQL request body.');
        return parsed as any;
      });
    },
  };
}
