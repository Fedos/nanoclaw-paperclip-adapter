import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import * as impl from "../index.js";
import { buildConfigSchema } from "./build-config-schema.js";

export { buildConfigSchema };

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: impl.type,
    execute: impl.execute,
    testEnvironment: impl.testEnvironment,
    models: impl.models,
    agentConfigurationDoc: impl.agentConfigurationDoc,
    getConfigSchema: () => buildConfigSchema(),
  };
}
