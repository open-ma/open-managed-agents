import { createProductionVercelControlPlane } from "../src/production.js";

const controlPlane = createProductionVercelControlPlane();

export default {
  fetch(request: Request): Promise<Response> | Response {
    return controlPlane.fetch(request);
  },
};
