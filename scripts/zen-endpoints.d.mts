/** Type surface for zen-endpoints.mjs (the build script is plain ESM JS). */
export declare const API_BY_ENDPOINT: readonly { pattern: RegExp; api: string }[];
export declare function apiForEndpoint(endpoint: string | undefined, id?: string): string;
