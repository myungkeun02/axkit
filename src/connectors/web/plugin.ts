import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import type { Lookup } from './address.js';
import { WebPageReader } from './reader.js';

export interface WebConnectorOptions {
  fetch?: typeof fetch;
  lookup?: Lookup;
}

/** Public web page reader for skills. Private and local addresses are refused. */
export function webConnector(options: WebConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.web',
      kind: 'connector',
      title: 'Web page reader',
    },
    setup(ctx) {
      ctx.provide(
        Contracts.webPage,
        new WebPageReader({
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
          ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
          clock: ctx.clock,
        }),
      );
    },
  };
}
