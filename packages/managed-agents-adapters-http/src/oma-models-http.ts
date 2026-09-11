import {
  bindPort,
  defineAppModule,
  type AppModule,
} from "@open-managed-agents/app";
import { httpClientPort } from "@open-managed-agents/app/capabilities";
import { openmaPortTokens } from "@open-managed-agents/app/openma";
import { OmaModelsApplicationService } from "@open-managed-agents/oma-models";
import { buildOmaModelRoutes } from "@open-managed-agents/oma-api";

import { HttpProviderModelCatalog } from "./provider-model-catalog";

export function buildOmaModelsHttpRoutes(dependencies: {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}) {
  return buildOmaModelRoutes(new OmaModelsApplicationService({
    catalog: new HttpProviderModelCatalog(dependencies),
  }));
}

export function omaModelsHttpModule(): AppModule {
  return defineAppModule({
    name: "openma:oma-models-http",
    provides: [openmaPortTokens.omaModels],
    requires: [httpClientPort],
    setup({ port }) {
      const http = port(httpClientPort);
      const catalog = new HttpProviderModelCatalog({
        fetch: (input, init) => http.fetch(input, init),
      });
      const service = new OmaModelsApplicationService({ catalog });
      return {
        ports: [bindPort(openmaPortTokens.omaModels, service)],
      };
    },
  });
}
