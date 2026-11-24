import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { localLifeTexts } from './locale.js';
import { lifeParcelTool } from './parcel-tool.js';
import { lifePlacesTool } from './places-tool.js';
import { lifePriceTool } from './price-tool.js';
import { homeFrom } from './shared.js';
import { lifeTransitTool } from './transit-tool.js';
import { lifeWeatherTool } from './weather-tool.js';

/** Life tools for Korean public services: weather, places, transit, parcels and prices. */
export function localLifeSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.local-life',
      kind: 'skill',
      title: 'Korean local life',
      needs: [
        Contracts.places,
        Contracts.weather,
        Contracts.transit,
        Contracts.parcel,
        Contracts.prices,
      ],
    },
    setup(ctx) {
      const texts = localLifeTexts(ctx.assistant.language);
      const places = ctx.use(Contracts.places);
      const phone = () => ctx.tryUse(Contracts.phoneSignals);
      const home = () => homeFrom(ctx.config);

      ctx.registerTool(
        lifeWeatherTool({ weather: ctx.use(Contracts.weather), places, phone, home, texts }),
      );
      ctx.registerTool(lifePlacesTool(places, texts));
      ctx.registerTool(lifeTransitTool(ctx.use(Contracts.transit), texts));
      ctx.registerTool(lifeParcelTool(ctx.use(Contracts.parcel), texts));
      ctx.registerTool(lifePriceTool(ctx.use(Contracts.prices), texts));
    },
  };
}
