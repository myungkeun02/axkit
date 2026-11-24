import { join } from 'node:path';
import { KeychainSecretStore, configPath, createLogger, loadConfig } from '../core/index.js';
import { buildApp } from '../app/build.js';
import { builtinPlugins } from '../app/plugins.js';
import { featureSetupPlugin } from '../app/feature-setup.js';
import { LAUNCHD_LABEL } from './service.js';
import { selfDevPlugin } from '../skills/self-dev/plugin.js';
import { selfDevOptions } from './self-dev-node.js';

export async function runStart(home: string): Promise<void> {
  const config = await loadConfig(configPath(home));
  const secrets = new KeychainSecretStore();
  const log = createLogger();
  const app = await buildApp({
    config,
    secrets,
    log,
    plugins: [
      ...builtinPlugins(config, { home }),
      featureSetupPlugin({
        configFile: configPath(home),
        // launchd (ax-kit service install) sets XPC_SERVICE_NAME and restarts the server after it exits.
        managed: process.env['XPC_SERVICE_NAME'] === LAUNCHD_LABEL,
        restart: () => process.kill(process.pid, 'SIGTERM'),
      }),
      selfDevPlugin(selfDevOptions(home)),
    ],
    storePath: join(home, 'data', 'ax-kit.db'),
  });

  await app.start();
  log.info('started', { assistant: config.assistant.name });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await app.stop(signal);
    } catch (error) {
      log.error('shutdown failed', { error: error instanceof Error ? error.message : String(error) });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}
