import { startTestServer } from "@pos/db/testing";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const server = await startTestServer();
  project.provide("pgAdminUrl", server.adminUrl);
  return async () => {
    await server.stop();
  };
}
