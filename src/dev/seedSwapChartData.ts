import { readConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createRepository, shouldRunPostgresMigration } from '../repository/factory.js';
import { createSwapChartFixtureDocuments } from './swapChartFixture.js';

const config = readConfig();
const repository = createRepository(config);

try {
  if (shouldRunPostgresMigration(config)) await migrate(config);
  const documents = createSwapChartFixtureDocuments();
  await repository.upsertMany(documents);
  console.info(`Seeded ${documents.length} swap chart fixture documents`);
} finally {
  await repository.close();
}
