import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { shellSnapshotFromReadModel } from "./projectCommands.ts";

const ACTIVE_PROJECT_ID = ProjectId.make("project-active");
const DELETED_PROJECT_ID = ProjectId.make("project-deleted");
const ACTIVE_THREAD_ID = ThreadId.make("thread-active");
const DELETED_THREAD_ID = ThreadId.make("thread-deleted");
const MODEL_SELECTION = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

describe("project commands", () => {
  it("converts an authoritative read model into an active shell snapshot", () => {
    const snapshot: OrchestrationReadModel = {
      snapshotSequence: 7,
      updatedAt: "2026-06-01T00:05:00.000Z",
      projects: [
        {
          id: ACTIVE_PROJECT_ID,
          title: "Active",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          deletedAt: null,
        },
        {
          id: DELETED_PROJECT_ID,
          title: "Deleted",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:01:00.000Z",
          deletedAt: "2026-06-01T00:02:00.000Z",
        },
      ],
      threads: [
        {
          id: ACTIVE_THREAD_ID,
          projectId: ACTIVE_PROJECT_ID,
          title: "Active thread",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: "/repo",
          latestTurn: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:04:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: MessageId.make("message-assistant"),
              role: "assistant",
              text: "Hello",
              turnId: null,
              streaming: false,
              createdAt: "2026-06-01T00:01:00.000Z",
              updatedAt: "2026-06-01T00:01:00.000Z",
            },
            {
              id: MessageId.make("message-user-old"),
              role: "user",
              text: "Older",
              turnId: null,
              streaming: false,
              createdAt: "2026-06-01T00:02:00.000Z",
              updatedAt: "2026-06-01T00:02:00.000Z",
            },
            {
              id: MessageId.make("message-user-new"),
              role: "user",
              text: "Newer",
              turnId: null,
              streaming: false,
              createdAt: "2026-06-01T00:03:00.000Z",
              updatedAt: "2026-06-01T00:03:00.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: null,
              planMarkdown: "Plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-06-01T00:03:30.000Z",
              updatedAt: "2026-06-01T00:03:30.000Z",
            },
          ],
          activities: [],
          checkpoints: [],
          session: null,
        },
        {
          id: DELETED_THREAD_ID,
          projectId: DELETED_PROJECT_ID,
          title: "Deleted thread",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:01:00.000Z",
          archivedAt: null,
          deletedAt: "2026-06-01T00:02:00.000Z",
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      ],
    };

    const shell = shellSnapshotFromReadModel(snapshot);

    expect(shell.projects.map((project) => project.id)).toEqual([ACTIVE_PROJECT_ID]);
    expect(shell.threads.map((thread) => thread.id)).toEqual([ACTIVE_THREAD_ID]);
    expect(shell.threads[0]).toMatchObject({
      latestUserMessageAt: "2026-06-01T00:03:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: true,
    });
    expect("messages" in (shell.threads[0] ?? {})).toBe(false);
  });
});
