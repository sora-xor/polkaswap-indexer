/** Durable loopback gateway. The reverse proxy exposes only this bounded router. */
import { ArchiveRouter } from '../archive-router.js';
import { createArchiveGateway, httpRpc } from '../archive-gateway.js';

const router = new ArchiveRouter(httpRpc('http://127.0.0.1:9944'), httpRpc('http://127.0.0.1:9947', '127.0.0.1:9946'));
await router.verify();
const gateway = createArchiveGateway(router, 'ws://127.0.0.1:9944');
gateway.server.listen(9948, '127.0.0.1');
const timer = setInterval(() => { void router.verify().catch(() => {
  console.error('Archive chain identity check failed; closing clients');
  clearInterval(timer);
  void gateway.close().then(() => process.exit(1), () => process.exit(1));
}); }, 30_000);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  clearInterval(timer);
  void gateway.close().then(() => process.exit(0), () => process.exit(1));
});
console.info('Canonical historical gateway listening on loopback port 9948');
