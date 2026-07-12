import {
  type EnvironmentId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type ProjectReadFileResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { type PreparedConnection, type PreparedHttpAuthorization } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
  remoteHttpClientLayer,
} from "../rpc/http.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export type ReadProjectSnapshotInput = Record<string, never>;

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

const ORCHESTRATION_SNAPSHOT_TIMEOUT_MS = 10_000;
const PREPARED_CONNECTION_WAIT_TIMEOUT = "15 seconds";

function latestUserMessageAt(thread: OrchestrationThread): string | null {
  let latest: string | null = null;
  for (const message of thread.messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latest === null || message.createdAt > latest) {
      latest = message.createdAt;
    }
  }
  return latest;
}

function hasActionableProposedPlan(thread: OrchestrationThread): boolean {
  const sorted = [...thread.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
  );
  let latestForTurn: (typeof sorted)[number] | null = null;
  if (thread.latestTurn !== null) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const plan = sorted[index];
      if (plan?.turnId === thread.latestTurn.turnId) {
        latestForTurn = plan;
        break;
      }
    }
  }

  const candidate = latestForTurn ?? sorted.at(-1) ?? null;
  return candidate !== null && candidate.implementedAt === null;
}

export function shellSnapshotFromReadModel(
  snapshot: OrchestrationReadModel,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
    projects: snapshot.projects.flatMap((project) =>
      project.deletedAt === null
        ? [
            {
              id: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              repositoryIdentity: project.repositoryIdentity,
              defaultModelSelection: project.defaultModelSelection,
              scripts: project.scripts,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            },
          ]
        : [],
    ),
    threads: snapshot.threads.flatMap((thread) =>
      thread.deletedAt === null
        ? [
            {
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              latestTurn: thread.latestTurn,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              archivedAt: thread.archivedAt,
              session: thread.session,
              latestUserMessageAt: latestUserMessageAt(thread),
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: hasActionableProposedPlan(thread),
            },
          ]
        : [],
    ),
  };
}

const persistReadModelCaches = Effect.fn("EnvironmentCommands.persistReadModelCaches")(function* (
  environmentId: EnvironmentId,
  snapshot: OrchestrationReadModel,
) {
  const cache = yield* EnvironmentCacheStore;
  yield* cache.saveShell(environmentId, shellSnapshotFromReadModel(snapshot));
  for (const thread of snapshot.threads) {
    if (thread.deletedAt === null) {
      yield* cache.saveThread(environmentId, {
        snapshotSequence: snapshot.snapshotSequence,
        thread,
      });
    } else {
      yield* cache.removeThread(environmentId, thread.id);
    }
  }
});

function currentPreparedConnection(): Effect.Effect<
  PreparedConnection,
  EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> {
  return Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const unavailable = new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: `${supervisor.target.label} is not ready for HTTP requests.`,
    });
    const poll = (): Effect.Effect<PreparedConnection> =>
      SubscriptionRef.get(supervisor.prepared).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.sleep("50 millis").pipe(Effect.andThen(poll())),
            onSome: Effect.succeed,
          }),
        ),
      );
    return yield* poll().pipe(
      Effect.timeoutOption(PREPARED_CONNECTION_WAIT_TIMEOUT),
      Effect.flatMap(
        Option.match({ onNone: () => Effect.fail(unavailable), onSome: Effect.succeed }),
      ),
    );
  });
}

function httpAuthorizationHeaders(
  authorization: PreparedHttpAuthorization | null,
  requestUrl: string,
): Effect.Effect<
  { readonly authorization?: string; readonly dpop?: string },
  ManagedRelay.ManagedRelayDpopProofCreationError,
  ManagedRelay.ManagedRelayDpopSigner
> {
  if (authorization === null) {
    return Effect.succeed({});
  }
  if (authorization._tag === "Bearer") {
    return Effect.succeed({ authorization: `Bearer ${authorization.token}` });
  }

  return Effect.gen(function* () {
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    const dpop = yield* signer.createProof({
      method: "GET",
      url: requestUrl,
      accessToken: authorization.accessToken,
    });
    return {
      authorization: `DPoP ${authorization.accessToken}`,
      dpop,
    };
  });
}

const readProjectSnapshot: (
  input: ReadProjectSnapshotInput,
) => Effect.Effect<
  OrchestrationReadModel,
  EnvironmentRpcUnavailableError | RemoteEnvironmentRequestError,
  EnvironmentSupervisor | EnvironmentCacheStore | ManagedRelay.ManagedRelayDpopSigner
> = Effect.fn("EnvironmentCommands.readProjectSnapshot")(function* (_input) {
  const prepared = yield* currentPreparedConnection();
  const requestUrl = environmentEndpointUrl(prepared.httpBaseUrl, "/api/orchestration/snapshot");
  const headers = yield* httpAuthorizationHeaders(prepared.httpAuthorization, requestUrl).pipe(
    Effect.mapError(
      () =>
        new EnvironmentRpcUnavailableError({
          environmentId: prepared.environmentId,
          message: `${prepared.label} could not authorize the HTTP request.`,
        }),
    ),
  );
  const request = Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(prepared.httpBaseUrl);
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      ORCHESTRATION_SNAPSHOT_TIMEOUT_MS,
      client.orchestration.snapshot({ headers }),
    );
  });

  const snapshot = yield* request.pipe(Effect.provide(remoteHttpClientLayer(globalThis.fetch)));
  yield* persistReadModelCaches(prepared.environmentId, snapshot).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not persist orchestration snapshot cache.").pipe(
        Effect.annotateLogs({
          environmentId: prepared.environmentId,
          ...safeErrorLogAttributes(error),
        }),
      ),
    ),
  );
  return snapshot;
});

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry
    | EnvironmentCacheStore
    | Crypto.Crypto
    | ManagedRelay.ManagedRelayDpopSigner
    | R,
    E
  >,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  const snapshotConcurrency = {
    mode: "singleFlight" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    readSnapshot: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:read-snapshot",
      execute: (input: ReadProjectSnapshotInput) => readProjectSnapshot(input),
      scheduler: projectScheduler,
      concurrency: snapshotConcurrency,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
  };
}
