import { prepareFlyMachineEnvironment } from "./production.js";

prepareFlyMachineEnvironment(process.env);

// Import only after Fly metadata has been projected into the Node contract;
// main-node constructs its stores and long-running workers during module load.
await import("@open-managed-agents/main-node");
