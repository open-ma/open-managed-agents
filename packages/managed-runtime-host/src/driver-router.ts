import type {
  HarnessDriverType,
  SandboxHarnessDriverCapabilities,
  SandboxHarnessDriverPort,
} from "@open-managed-agents/runtime-resource-contract";

const driverOrder: readonly HarnessDriverType[] = [
  "ama_worker",
  "openma_supervised",
];

async function registrations(
  drivers: readonly SandboxHarnessDriverPort[],
  scope: Parameters<SandboxHarnessDriverPort["driverCapabilities"]>[0],
): Promise<Map<HarnessDriverType, SandboxHarnessDriverPort>> {
  const capabilities = await Promise.all(
    drivers.map(async (driver) => ({
      driver,
      capabilities: await driver.driverCapabilities(scope),
    })),
  );
  const registered = new Map<HarnessDriverType, SandboxHarnessDriverPort>();
  for (const { driver, capabilities: advertised } of capabilities) {
    for (const type of advertised.drivers) {
      if (registered.has(type)) {
        throw new Error(`Duplicate sandbox harness driver registration: ${type}`);
      }
      registered.set(type, driver);
    }
  }
  return registered;
}

/**
 * Composes independent execution lanes without wrapping or translating their
 * protocol. In particular, registering the enhanced supervisor lane never
 * changes an `ama_worker` declaration or requires a community worker to speak
 * an OpenMA-specific control protocol.
 */
export function composeSandboxHarnessDrivers(
  ...drivers: readonly SandboxHarnessDriverPort[]
): SandboxHarnessDriverPort {
  return {
    async driverCapabilities(scope): Promise<SandboxHarnessDriverCapabilities> {
      const registered = await registrations(drivers, scope);
      return {
        drivers: driverOrder.filter((type) => registered.has(type)),
      };
    },

    async run(input) {
      const registered = await registrations(drivers, input.scope);
      const selected = registered.get(input.driver.type);
      if (selected === undefined) {
        throw new Error(
          `No sandbox harness driver is registered for ${input.driver.type}`,
        );
      }
      return selected.run(input);
    },
  };
}
