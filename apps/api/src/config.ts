import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });
export const dataDir = process.env.DATA_DIR || path.join(root, 'data');
export const sourceNames = ['adt', 'lis', 'formulary'] as const;
export type SourceName = typeof sourceNames[number];
export const ports = { adt: Number(process.env.ADT_PORT || 8001), lis: Number(process.env.LIS_PORT || 8002), formulary: Number(process.env.FORMULARY_PORT || 8003) };
export const hubPort = Number(process.env.HUB_PORT || 8000);
export const sourceToken = process.env.SOURCE_API_TOKEN || '';
export const syncInterval = Number(process.env.SYNC_INTERVAL_MS || 2000);
export const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

export class AppError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
