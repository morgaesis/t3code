import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isDraftThreadForProjectRef } from "./useHandleNewThread";

describe("isDraftThreadForProjectRef", () => {
  it("requires both environment and project identity to match", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const projectId = ProjectId.make("project-a");
    const draftThread = { environmentId, projectId };

    expect(
      isDraftThreadForProjectRef(draftThread, {
        environmentId,
        projectId,
      }),
    ).toBe(true);
    expect(
      isDraftThreadForProjectRef(draftThread, {
        environmentId: EnvironmentId.make("environment-b"),
        projectId,
      }),
    ).toBe(false);
    expect(
      isDraftThreadForProjectRef(draftThread, {
        environmentId,
        projectId: ProjectId.make("project-b"),
      }),
    ).toBe(false);
  });
});
