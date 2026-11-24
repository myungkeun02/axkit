import type { RemoteSource } from '../core/contracts/remote.js';
import type { SecretReader } from '../core/secrets/types.js';
import { remoteTokenSecret } from '../core/remote/ids.js';
import type { PostJson } from '../connectors/remote-sources/http.js';
import { HttpRemoteSource } from '../connectors/remote-sources/source.js';
import type { PairedRemote } from '../connectors/remote-sources/store.js';

/** The paired Macs as sources, for `ax-kit setup` and `ax-kit remote` before the server runs. */
export function remoteSourcesFrom(remotes: readonly PairedRemote[], secrets: SecretReader, post?: PostJson): RemoteSource[] {
  return remotes.map(
    (remote) =>
      new HttpRemoteSource({
        name: remote.name,
        url: remote.url,
        token: () => secrets.get(remoteTokenSecret(remote.name)),
        ...(post !== undefined ? { post } : {}),
      }),
  );
}
