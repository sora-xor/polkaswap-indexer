import { readConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { PostgresRepository } from '../repository/postgres.js';
import { createSwapChartFixtureDocuments } from './swapChartFixture.js';

const config = readConfig();
const repository = new PostgresRepository(config.databaseUrl);

try {
  await migrate(config.databaseUrl);
  const documents = createSwapChartFixtureDocuments();
  await repository.upsertMany(documents);
  console.info(`Seeded ${documents.length} swap chart fixture documents`);
} finally {
  await repository.close();
}
