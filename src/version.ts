// APP_VERSION is injected at build time (`bun build --define APP_VERSION=...`).
// When running from source it falls back to package.json.
declare const APP_VERSION: string | undefined;

import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = typeof APP_VERSION === 'string' && APP_VERSION ? APP_VERSION : pkg.version;
