import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import * as impl from "../index.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: impl.type,
    execute: impl.execute,
    testEnvironment: impl.testEnvironment,
    models: impl.models,
    agentConfigurationDoc: impl.agentConfigurationDoc,
  };
}
