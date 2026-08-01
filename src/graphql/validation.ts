import {
  GraphQLError,
  Kind,
  visit,
} from 'graphql';

import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLSchema,
  SelectionSetNode,
  ASTNode,
  ValidationRule,
} from 'graphql';
import type { Plugin } from 'graphql-yoga';

export type GraphQLQueryLimits = {
  maxDepth: number;
  maxDocumentNodes: number;
  maxFields: number;
  maxAliases: number;
  maxFragmentSpreads: number;
  maxOperationCost: number;
  allowIntrospection: boolean;
};

type SelectionAnalysis = {
  cost: number;
  depth: number;
  fields: number;
};

const DEFAULT_CONNECTION_PAGE_SIZE = 100;
const MAX_CONNECTION_PAGE_SIZE = 1_000;
const ROOT_QUERY_FIELD_BASE_COST: Readonly<Record<string, number>> = {
  // These fields perform several repository queries or scan a caller-selected
  // range. Charge the work before resolver execution so aliases cannot amplify
  // them as if they were constant-time scalar lookups.
  exploreStats: 10_000,
  networkAccountActivity: 75_000,
  polkamarktSignals: 75_000,
};

const limitError = (message: string, nodes?: ASTNode | readonly ASTNode[]): GraphQLError =>
  new GraphQLError(message, {
    nodes,
    extensions: { code: 'GRAPHQL_QUERY_LIMIT_EXCEEDED' },
  });

const saturatingAdd = (left: number, right: number, ceiling: number): number =>
  Math.min(left + right, ceiling);

const saturatingMultiply = (left: number, right: number, ceiling: number): number => {
  if (left === 0 || right === 0) return 0;
  if (left >= ceiling || right >= ceiling || left > Math.floor(ceiling / right)) return ceiling;
  return left * right;
};

const isCompositeLike = (type: unknown): type is GraphQLCompositeType =>
  Boolean(
    type &&
      typeof type === 'object' &&
      ('getFields' in type || 'getTypes' in type) &&
      (typeof (type as { getFields?: unknown }).getFields === 'function' ||
        typeof (type as { getTypes?: unknown }).getTypes === 'function')
  );

const namedType = (type: unknown): { name: string; getFields?: () => Record<string, unknown> } | undefined => {
  let current = type;
  while (current && typeof current === 'object' && 'ofType' in current) {
    current = (current as { ofType: unknown }).ofType;
  }
  if (!current || typeof current !== 'object' || !('name' in current) || typeof current.name !== 'string') {
    return undefined;
  }
  return current as { name: string; getFields?: () => Record<string, unknown> };
};

const compositeTypeForCondition = (
  schema: GraphQLSchema,
  typeCondition: FragmentDefinitionNode['typeCondition'] | undefined,
  fallback: GraphQLCompositeType | undefined
): GraphQLCompositeType | undefined => {
  if (!typeCondition) return fallback;
  const type = schema.getType(typeCondition.name.value);
  return isCompositeLike(type) ? type : fallback;
};

const fieldDefinition = (parentType: GraphQLCompositeType | undefined, fieldName: string) => {
  if (!parentType || !('getFields' in parentType) || typeof parentType.getFields !== 'function') return undefined;
  return parentType.getFields()[fieldName];
};

const connectionPageSize = (field: FieldNode, maxCost: number): number => {
  const first = field.arguments?.find((argument) => argument.name.value === 'first')?.value;
  if (!first) return DEFAULT_CONNECTION_PAGE_SIZE;
  if (first.kind === Kind.VARIABLE) return MAX_CONNECTION_PAGE_SIZE;
  if (first.kind !== Kind.INT) return MAX_CONNECTION_PAGE_SIZE;

  try {
    const value = BigInt(first.value);
    if (value <= 0n) return 1;
    return value > BigInt(maxCost + 1) ? maxCost + 1 : Number(value);
  } catch {
    return maxCost + 1;
  }
};

const selectionAnalysis = (
  schema: GraphQLSchema,
  selectionSet: SelectionSetNode,
  parentType: GraphQLCompositeType | undefined,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  fragmentStack: ReadonlySet<string>,
  fragmentMemo: Map<string, SelectionAnalysis>,
  limits: GraphQLQueryLimits
): SelectionAnalysis => {
  const costCeiling = limits.maxOperationCost + 1;
  const fieldCeiling = limits.maxFields + 1;
  let cost = 0;
  let depth = 0;
  let fields = 0;

  for (const selection of selectionSet.selections) {
    let child: SelectionAnalysis = { cost: 0, depth: 0, fields: 0 };

    if (selection.kind === Kind.FIELD) {
      const definition = fieldDefinition(parentType, selection.name.value);
      const namedReturnType = namedType(definition?.type);
      const childType = isCompositeLike(namedReturnType) ? namedReturnType : undefined;

      if (selection.selectionSet) {
        child = selectionAnalysis(
          schema,
          selection.selectionSet,
          childType,
          fragments,
          fragmentStack,
          fragmentMemo,
          limits
        );
      }

      const isConnection = namedReturnType?.name.endsWith('Connection') ?? false;
      const hasPaginationArgument = Boolean(
        definition &&
          typeof definition === 'object' &&
          'args' in definition &&
          Array.isArray(definition.args) &&
          definition.args.some(
            (argument) =>
              argument &&
              typeof argument === 'object' &&
              'name' in argument &&
              argument.name === 'first'
          )
      );
      const pageSize = isConnection && hasPaginationArgument ? connectionPageSize(selection, limits.maxOperationCost) : 1;
      const childCost = saturatingMultiply(child.cost, pageSize, costCeiling);
      const baseCost =
        parentType?.name === 'Query' ? (ROOT_QUERY_FIELD_BASE_COST[selection.name.value] ?? 1) : 1;

      cost = saturatingAdd(cost, saturatingAdd(baseCost, childCost, costCeiling), costCeiling);
      fields = saturatingAdd(fields, saturatingAdd(1, child.fields, fieldCeiling), fieldCeiling);
      depth = Math.max(depth, 1 + child.depth);
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      child = selectionAnalysis(
        schema,
        selection.selectionSet,
        compositeTypeForCondition(schema, selection.typeCondition, parentType),
        fragments,
        fragmentStack,
        fragmentMemo,
        limits
      );
    } else {
      const fragmentName = selection.name.value;
      if (fragmentStack.has(fragmentName)) continue;

      const fragment = fragments.get(fragmentName);
      if (!fragment) continue;

      const memoized = fragmentMemo.get(fragmentName);
      if (memoized) {
        child = memoized;
      } else {
        const nextStack = new Set(fragmentStack);
        nextStack.add(fragmentName);
        child = selectionAnalysis(
          schema,
          fragment.selectionSet,
          compositeTypeForCondition(schema, fragment.typeCondition, parentType),
          fragments,
          nextStack,
          fragmentMemo,
          limits
        );
        fragmentMemo.set(fragmentName, child);
      }
    }

    cost = saturatingAdd(cost, child.cost, costCeiling);
    fields = saturatingAdd(fields, child.fields, fieldCeiling);
    depth = Math.max(depth, child.depth);
  }

  return { cost, depth, fields };
};

/**
 * Adds deterministic, schema-aware resource bounds to GraphQL validation.
 *
 * Connection selections multiply their child cost by the requested `first`
 * value. Variable page sizes are charged at the API's maximum page size so a
 * small-looking document cannot bypass the budget with variables.
 */
export const createGraphQLQueryLimitsRule = (limits: GraphQLQueryLimits): ValidationRule => (context) => ({
  Document: {
    leave(document: DocumentNode) {
      let aliases = 0;
      let documentNodes = 0;
      let fragmentSpreads = 0;
      let introspectionNode: FieldNode | undefined;

      visit(document, {
        enter(node) {
          documentNodes += 1;
          if (node.kind === Kind.FIELD) {
            if (node.alias) aliases += 1;
            if (node.name.value === '__schema' || node.name.value === '__type') introspectionNode ??= node;
          } else if (node.kind === Kind.FRAGMENT_SPREAD) {
            fragmentSpreads += 1;
          }
        },
      });

      if (documentNodes > limits.maxDocumentNodes) {
        context.reportError(
          limitError(
            `GraphQL document contains ${documentNodes} AST nodes; maximum is ${limits.maxDocumentNodes}.`,
            document
          )
        );
      }
      if (aliases > limits.maxAliases) {
        context.reportError(
          limitError(`GraphQL document contains ${aliases} aliases; maximum is ${limits.maxAliases}.`, document)
        );
      }
      if (fragmentSpreads > limits.maxFragmentSpreads) {
        context.reportError(
          limitError(
            `GraphQL document contains ${fragmentSpreads} fragment spreads; maximum is ${limits.maxFragmentSpreads}.`,
            document
          )
        );
      }
      if (!limits.allowIntrospection && introspectionNode) {
        context.reportError(limitError('GraphQL schema introspection is disabled.', introspectionNode));
      }

      const schema = context.getSchema();
      const fragments = new Map(
        document.definitions
          .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
          .map((fragment) => [fragment.name.value, fragment])
      );

      for (const operation of document.definitions) {
        if (operation.kind !== Kind.OPERATION_DEFINITION) continue;

        const rootType =
          operation.operation === 'query'
            ? schema.getQueryType()
            : operation.operation === 'mutation'
              ? schema.getMutationType()
              : schema.getSubscriptionType();
        const analysis = selectionAnalysis(
          schema,
          operation.selectionSet,
          rootType ?? undefined,
          fragments,
          new Set(),
          new Map(),
          limits
        );
        const operationName = operation.name?.value ? ` "${operation.name.value}"` : '';

        if (analysis.depth > limits.maxDepth) {
          context.reportError(
            limitError(
              `GraphQL operation${operationName} has depth ${analysis.depth}; maximum is ${limits.maxDepth}.`,
              operation
            )
          );
        }
        if (analysis.fields > limits.maxFields) {
          context.reportError(
            limitError(
              `GraphQL operation${operationName} expands to ${analysis.fields} fields; maximum is ${limits.maxFields}.`,
              operation
            )
          );
        }
        if (analysis.cost > limits.maxOperationCost) {
          context.reportError(
            limitError(
              `GraphQL operation${operationName} has estimated cost above the maximum of ${limits.maxOperationCost}.`,
              operation
            )
          );
        }
      }
    },
  },
});

export const useGraphQLQueryLimits = (limits: GraphQLQueryLimits): Plugin => ({
  onValidate({ addValidationRule }) {
    addValidationRule(createGraphQLQueryLimitsRule(limits));
  },
});
