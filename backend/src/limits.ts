import {Buffer} from 'node:buffer';

// Leave room for RPC snapshot versions and the runtime's JSON buffers.
export const MAX_PROJECT_BYTES = 12_000_000;
export const MAX_REQUEST_BYTES = 16_000_000;
export const MAX_ROW_BYTES = 64_000;
export const MAX_META_BYTES = 1_000_000;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
