import { statfs } from 'node:fs/promises';

export const rocksAvailableBytes = async (path: string): Promise<number> => {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
};
