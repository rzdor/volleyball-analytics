#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function formatAzError(error) {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim();
  }

  return error instanceof Error ? error.message : String(error);
}

function runAz(args, options = {}) {
  try {
    return execFileSync('az', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (options.allowFailure) {
      return undefined;
    }

    throw new Error(`Azure CLI command failed: az ${args.join(' ')}\n${formatAzError(error)}`);
  }
}

function runAzJson(args, options = {}) {
  const output = runAz([...args, '-o', 'json'], options);
  if (!output) {
    return undefined;
  }

  return JSON.parse(output);
}

function runAzTsv(args, options = {}) {
  return runAz([...args, '-o', 'tsv'], options);
}

function buildCosmosAuthToken(verb, resourceType, resourceLink, utcDate, masterKey) {
  const payload = `${verb.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceLink}\n${utcDate.toLowerCase()}\n\n`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(masterKey, 'base64'))
    .update(payload, 'utf8')
    .digest('base64');

  return encodeURIComponent(`type=master&ver=1.0&sig=${signature}`);
}

async function cosmosRequest(params) {
  const utcDate = new Date().toUTCString();
  const authorization = buildCosmosAuthToken(
    params.method,
    params.resourceType,
    params.resourceLink,
    utcDate,
    params.masterKey,
  );

  const response = await fetch(new URL(params.path, params.endpoint), {
    method: params.method,
    headers: {
      authorization,
      'x-ms-date': utcDate,
      'x-ms-version': '2018-12-31',
      ...(params.headers ?? {}),
    },
    body: params.body,
  });

  const rawBody = await response.text();
  if (!response.ok) {
    const error = new Error(
      `Cosmos request failed with ${response.status} ${response.statusText}${rawBody ? `: ${rawBody}` : ''}`,
    );
    Object.assign(error, { statusCode: response.status });
    throw error;
  }

  return {
    response,
    body: rawBody ? JSON.parse(rawBody) : undefined,
  };
}

async function listCosmosDocuments(params) {
  const resourceLink = `dbs/${params.databaseName}/colls/${params.containerName}`;
  let continuation = '';
  const documents = [];

  while (true) {
    const { response, body } = await cosmosRequest({
      endpoint: params.endpoint,
      masterKey: params.masterKey,
      method: 'POST',
      resourceType: 'docs',
      resourceLink,
      path: `${resourceLink}/docs`,
      headers: {
        'Content-Type': 'application/query+json',
        'x-ms-documentdb-isquery': 'true',
        'x-ms-documentdb-query-enablecrosspartition': 'true',
        'x-ms-max-item-count': '200',
        ...(continuation ? { 'x-ms-continuation': continuation } : {}),
      },
      body: JSON.stringify({
        query: 'SELECT c.id, c.recordId FROM c',
        parameters: [],
      }),
    });

    const pageDocuments = Array.isArray(body?.Documents) ? body.Documents : [];
    for (const document of pageDocuments) {
      if (typeof document?.id === 'string' && typeof document?.recordId === 'string') {
        documents.push({
          id: document.id,
          recordId: document.recordId,
        });
      }
    }

    continuation = response.headers.get('x-ms-continuation') ?? '';
    if (!continuation) {
      return documents;
    }
  }
}

async function deleteCosmosDocuments() {
  const resourceGroup = getRequiredEnv('AZURE_RESOURCE_GROUP');
  const accountName = getRequiredEnv('COSMOS_ACCOUNT_NAME');
  const databaseName = getRequiredEnv('COSMOS_DB_DATABASE_NAME');
  const containerName = getRequiredEnv('COSMOS_DB_CONTAINER_NAME');

  const account = runAzJson([
    'cosmosdb',
    'show',
    '--resource-group',
    resourceGroup,
    '--name',
    accountName,
  ], { allowFailure: true });

  if (!account) {
    console.log(`[cleanup] Cosmos account ${accountName} not found; skipping read-model cleanup.`);
    return 0;
  }

  const containerExists = runAzTsv([
    'cosmosdb',
    'sql',
    'container',
    'exists',
    '--resource-group',
    resourceGroup,
    '--account-name',
    accountName,
    '--database-name',
    databaseName,
    '--name',
    containerName,
    '--query',
    'exists',
  ], { allowFailure: true });

  if (containerExists !== 'true') {
    console.log(`[cleanup] Cosmos container ${databaseName}/${containerName} not found; skipping read-model cleanup.`);
    return 0;
  }

  const endpoint = runAzTsv([
    'cosmosdb',
    'show',
    '--resource-group',
    resourceGroup,
    '--name',
    accountName,
    '--query',
    'documentEndpoint',
  ]);
  const masterKey = runAzTsv([
    'cosmosdb',
    'keys',
    'list',
    '--resource-group',
    resourceGroup,
    '--name',
    accountName,
    '--query',
    'primaryMasterKey',
  ]);

  const documents = await listCosmosDocuments({
    endpoint: endpoint.endsWith('/') ? endpoint : `${endpoint}/`,
    masterKey,
    databaseName,
    containerName,
  });

  if (documents.length === 0) {
    console.log('[cleanup] Cosmos read-model container is already empty.');
    return 0;
  }

  console.log(`[cleanup] Deleting ${documents.length} Cosmos document(s) from ${databaseName}/${containerName}...`);

  let deletedCount = 0;
  for (const document of documents) {
    await cosmosRequest({
      endpoint: endpoint.endsWith('/') ? endpoint : `${endpoint}/`,
      masterKey,
      method: 'DELETE',
      resourceType: 'docs',
      resourceLink: `dbs/${databaseName}/colls/${containerName}/docs/${document.id}`,
      path: `dbs/${databaseName}/colls/${containerName}/docs/${encodeURIComponent(document.id)}`,
      headers: {
        'x-ms-documentdb-partitionkey': JSON.stringify([document.recordId]),
      },
    });
    deletedCount += 1;
  }

  console.log(`[cleanup] Deleted ${deletedCount} Cosmos document(s).`);
  return deletedCount;
}

function deleteTableEntities() {
  const resourceGroup = getRequiredEnv('AZURE_RESOURCE_GROUP');
  const accountName = getRequiredEnv('STORAGE_ACCOUNT_NAME');
  const tableName = getRequiredEnv('VIDEO_RECORDS_TABLE_NAME');

  const storageAccount = runAzJson([
    'storage',
    'account',
    'show',
    '--resource-group',
    resourceGroup,
    '--name',
    accountName,
  ], { allowFailure: true });

  if (!storageAccount) {
    console.log(`[cleanup] Storage account ${accountName} not found; skipping table cleanup.`);
    return 0;
  }

  const accountKey = runAzTsv([
    'storage',
    'account',
    'keys',
    'list',
    '--resource-group',
    resourceGroup,
    '--account-name',
    accountName,
    '--query',
    '[0].value',
  ]);
  const tableExists = runAzTsv([
    'storage',
    'table',
    'exists',
    '--account-name',
    accountName,
    '--account-key',
    accountKey,
    '--name',
    tableName,
    '--query',
    'exists',
  ]);

  if (tableExists !== 'true') {
    console.log(`[cleanup] Table ${tableName} not found; skipping table cleanup.`);
    return 0;
  }

  const entities = runAzJson([
    'storage',
    'entity',
    'query',
    '--account-name',
    accountName,
    '--account-key',
    accountKey,
    '--table-name',
    tableName,
    '--select',
    'PartitionKey',
    'RowKey',
    '--query',
    '[].{partitionKey:PartitionKey,rowKey:RowKey}',
  ]) ?? [];

  if (!Array.isArray(entities) || entities.length === 0) {
    console.log('[cleanup] Video records table is already empty.');
    return 0;
  }

  console.log(`[cleanup] Deleting ${entities.length} table entit${entities.length === 1 ? 'y' : 'ies'} from ${tableName}...`);

  let deletedCount = 0;
  for (const entity of entities) {
    if (typeof entity?.partitionKey !== 'string' || typeof entity?.rowKey !== 'string') {
      continue;
    }

    runAz([
      'storage',
      'entity',
      'delete',
      '--account-name',
      accountName,
      '--account-key',
      accountKey,
      '--table-name',
      tableName,
      '--partition-key',
      entity.partitionKey,
      '--row-key',
      entity.rowKey,
      '--if-match',
      '*',
      '-o',
      'none',
    ]);
    deletedCount += 1;
  }

  console.log(`[cleanup] Deleted ${deletedCount} table entit${deletedCount === 1 ? 'y' : 'ies'}.`);
  return deletedCount;
}

async function main() {
  const deletedCosmosDocuments = await deleteCosmosDocuments();
  const deletedTableEntities = deleteTableEntities();

  console.log(`[cleanup] Finished. Cosmos documents deleted: ${deletedCosmosDocuments}. Table entities deleted: ${deletedTableEntities}.`);
}

main().catch((error) => {
  console.error('[cleanup] Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
