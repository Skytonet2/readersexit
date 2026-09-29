import { Buffer } from "buffer";

// Some wallet modules expect Node's Buffer global.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

