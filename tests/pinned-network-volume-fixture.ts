// Exact literal operations from polkaswap-exchange-web/src/indexer/queries/network/volume.ts.
// Captured source and genuine initial-page public diagnostic are pinned below;
// fixtures are local and never read the frontend checkout or contact its API.
export const PINNED_NETWORK_VOLUME_SOURCE = {
  "source": "src/indexer/queries/network/volume.ts",
  "sourceSha256": "da65aaa6013d4672527e8d02f6d5f3ae6b101e3fe6390c1092337e7b2dcad429",
  "actualPublicDiagnosticSha256": "86602c949c9a54193ad13371d8dc61d5680286aaa3bd754771d428404c6f526c"
} as const;

export const PINNED_NETWORK_VOLUME_QUERIES = [
  {
    "operation": "PolkaswapNetworkVolumeQuery",
    "querySha256": "eb26dd0c355f19a48148f9d16713249ef8b3bb9c0e1e740c3e247168aa6b8eda",
    "query": "\n  query NetworkVolumeQuery($after: Cursor, $type: SnapshotType, $from: Int, $to: Int) {\n    data: networkSnapshots(\n      after: $after\n      orderBy: TIMESTAMP_DESC\n      filter: {\n        and: [\n          { type: { equalTo: $type } }\n          { timestamp: { lessThanOrEqualTo: $from } }\n          { timestamp: { greaterThanOrEqualTo: $to } }\n        ]\n      }\n    ) {\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        node {\n          timestamp\n          volumeUSD\n        }\n      }\n    }\n  }\n",
    "type": "HOUR",
    "metric": "volumeUSD",
    "positiveOnly": false
  },
  {
    "operation": "PolkaswapNetworkFeesQuery",
    "querySha256": "1e120fc455798a7468411884c8bc73586e65722cc55818d0d708f9428bebde39",
    "query": "\n  query NetworkFeesQuery($after: Cursor, $type: SnapshotType, $from: Int, $to: Int) {\n    data: networkSnapshots(\n      after: $after\n      orderBy: TIMESTAMP_DESC\n      filter: {\n        and: [\n          { type: { equalTo: $type } }\n          { timestamp: { lessThanOrEqualTo: $from } }\n          { timestamp: { greaterThanOrEqualTo: $to } }\n        ]\n      }\n    ) {\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        node {\n          timestamp\n          fees\n        }\n      }\n    }\n  }\n",
    "type": "HOUR",
    "metric": "fees",
    "positiveOnly": false
  },
  {
    "operation": "PolkaswapNetworkBlockFeesQuery",
    "querySha256": "89d056d91e86528c74e28285b21136c8d8295bc84705c7c12a204fe0ee87d713",
    "query": "\n  query NetworkBlockFeesQuery($after: Cursor, $type: SnapshotType, $from: Int, $to: Int) {\n    data: networkSnapshots(\n      after: $after\n      orderBy: TIMESTAMP_DESC\n      filter: {\n        and: [\n          { type: { equalTo: $type } }\n          { timestamp: { lessThanOrEqualTo: $from } }\n          { timestamp: { greaterThanOrEqualTo: $to } }\n          { fees: { greaterThan: \"0\" } }\n        ]\n      }\n    ) {\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        node {\n          timestamp\n          fees\n        }\n      }\n    }\n  }\n",
    "type": "BLOCK",
    "metric": "fees",
    "positiveOnly": true
  },
  {
    "operation": "PolkaswapNetworkBlockVolumeQuery",
    "querySha256": "54548dd439f5a63b927374067c225e322ecfdf1acd465699e27c3014bb9fd0a0",
    "query": "\n  query NetworkBlockVolumeQuery($after: Cursor, $type: SnapshotType, $from: Int, $to: Int) {\n    data: networkSnapshots(\n      after: $after\n      orderBy: TIMESTAMP_DESC\n      filter: {\n        and: [\n          { type: { equalTo: $type } }\n          { timestamp: { lessThanOrEqualTo: $from } }\n          { timestamp: { greaterThanOrEqualTo: $to } }\n          { volumeUSD: { greaterThan: \"0\" } }\n        ]\n      }\n    ) {\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        node {\n          timestamp\n          volumeUSD\n        }\n      }\n    }\n  }\n",
    "type": "BLOCK",
    "metric": "volumeUSD",
    "positiveOnly": true
  }
] as const;
