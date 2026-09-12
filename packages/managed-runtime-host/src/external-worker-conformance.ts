/** Minimal structural surface shared by the official SDK and compatible
 * clients. Keeping this probe independent from a concrete SDK instance makes
 * it usable against BYOW implementations without pulling their deployment
 * model into the OpenMA kernel. */
export interface ExternalEnvironmentWork {
  id: string;
  environment_id: string;
  secret?: string | null;
  data: { type?: string; id: string };
}

export interface ExternalEnvironmentWorkPoller
  extends AsyncIterable<ExternalEnvironmentWork> {
  abort(): void;
}

export interface ExternalEnvironmentWorkLifecycleClient {
  beta: {
    environments: {
      work: {
        heartbeat(
          workId: string,
          input: {
            environment_id: string;
            desired_ttl_seconds: number;
            expected_last_heartbeat: string;
          },
        ): PromiseLike<{
          lease_extended: boolean;
          state: string;
          ttl_seconds: number;
        }>;
        stop(
          workId: string,
          input: { environment_id: string; force: true },
        ): PromiseLike<{ state?: string }>;
      };
    };
  };
}

export interface ExternalEnvironmentWorkerConformanceClient
  extends ExternalEnvironmentWorkLifecycleClient {
  beta: ExternalEnvironmentWorkLifecycleClient["beta"] & {
    environments: ExternalEnvironmentWorkLifecycleClient["beta"]["environments"] & {
      work: ExternalEnvironmentWorkLifecycleClient["beta"]["environments"]["work"] & {
        poller(input: {
          environmentId: string;
          environmentKey: string;
          workerId?: string;
          autoStop: false;
          blockMs: null;
          drain: true;
        }): ExternalEnvironmentWorkPoller;
      };
    };
  };
}

export interface ExternalEnvironmentWorkerConformanceOptions {
  client: ExternalEnvironmentWorkerConformanceClient;
  environmentId: string;
  environmentKey: string;
  /** A probe is destructive: pin it to the deliberately enqueued Work item. */
  expectedWorkId: string;
  workerId?: string;
  heartbeatTtlSeconds?: number;
  /** Build the post-claim client from `secret.sessions_token`. Official SDK
   * workers prefer that token for heartbeat/stop as well as Session APIs. */
  claimClientFor: (
    work: ExternalEnvironmentWork,
  ) => ExternalEnvironmentWorkLifecycleClient;
  /** Verify that the opaque per-work secret can reach only the claimed
   * Session/resources. The callback normally instantiates a Session client. */
  verifyWorkSecret?: (work: ExternalEnvironmentWork) => Promise<void>;
}

export interface ExternalEnvironmentWorkerConformanceReport {
  environmentId: string;
  workId: string;
  sessionId: string;
  heartbeatTtlSeconds: number;
  state: string;
}

/**
 * Destructive protocol probe for an already-enqueued disposable Session.
 *
 * The official WorkPoller owns poll + ACK. This function then proves the
 * claimed lease, optional session-secret access, and terminal stop. On any
 * failure it intentionally does not stop the Work so lease expiry can make it
 * reclaimable for diagnosis/retry.
 */
export async function runExternalEnvironmentWorkerConformance(
  options: ExternalEnvironmentWorkerConformanceOptions,
): Promise<ExternalEnvironmentWorkerConformanceReport> {
  const heartbeatTtlSeconds = options.heartbeatTtlSeconds ?? 90;
  if (!Number.isSafeInteger(heartbeatTtlSeconds) || heartbeatTtlSeconds <= 0) {
    throw new RangeError("heartbeatTtlSeconds must be a positive integer");
  }
  if (options.expectedWorkId === "") {
    throw new Error("expectedWorkId is required because the probe force-stops Work");
  }
  const poller = options.client.beta.environments.work.poller({
    environmentId: options.environmentId,
    environmentKey: options.environmentKey,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    autoStop: false,
    blockMs: null,
    drain: true,
  });
  try {
    let claimed: ExternalEnvironmentWork | null = null;
    for await (const work of poller) {
      claimed = work;
      break;
    }
    if (claimed === null) {
      throw new Error("Environment Worker conformance probe found no queued Work");
    }
    if (
      claimed.id !== options.expectedWorkId
      || claimed.environment_id !== options.environmentId
    ) {
      throw new Error(
        `Environment Worker conformance probe claimed unexpected Work ${claimed.id}`,
      );
    }
    if (claimed.data.type !== "session" || claimed.secret == null || claimed.secret === "") {
      throw new Error("Environment Worker conformance probe requires Session Work with a secret");
    }
    const lifecycleClient = options.claimClientFor(claimed);
    const heartbeat = await lifecycleClient.beta.environments.work.heartbeat(
      claimed.id,
      {
        environment_id: options.environmentId,
        desired_ttl_seconds: heartbeatTtlSeconds,
        expected_last_heartbeat: "NO_HEARTBEAT",
      },
    );
    if (!heartbeat.lease_extended || heartbeat.state !== "active") {
      throw new Error(
        `Environment Worker conformance heartbeat did not retain an active lease (${heartbeat.state})`,
      );
    }
    await options.verifyWorkSecret?.(claimed);
    const stopped = await lifecycleClient.beta.environments.work.stop(claimed.id, {
      environment_id: options.environmentId,
      force: true,
    });
    return {
      environmentId: options.environmentId,
      workId: claimed.id,
      sessionId: claimed.data.id,
      heartbeatTtlSeconds: heartbeat.ttl_seconds,
      state: stopped.state ?? "stopped",
    };
  } finally {
    poller.abort();
  }
}
