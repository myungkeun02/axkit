/** Capability "core.feature-setup": turning on a feature the owner agreed to, from chat instead of `ax-kit setup`. */
export interface FeatureSetup {
  /** True when config turns this plugin on (`plugins[id].enabled`). */
  isOn(pluginId: string): boolean;
  /**
   * Writes `enabled: true` for these plugins into the config file. A server running as the login service restarts
   * itself a few seconds later so they load ("soon"); otherwise the owner restarts it ("manual").
   */
  turnOn(pluginIds: readonly string[]): Promise<{ restart: 'soon' | 'manual' }>;
}
