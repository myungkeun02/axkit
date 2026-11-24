import { createDiscordJsPort } from './discordjs-port.js';
import { newPairingCode, waitForOwnerPairing } from './pairing.js';

export { createDiscordJsPort, newPairingCode, waitForOwnerPairing };

/** Owner pairing for the setup flow: a code in the terminal, redeemed by a DM. */
export const discordPairing = {
  newPairingCode,
  waitForOwnerPairing,
  createPort: createDiscordJsPort,
};
