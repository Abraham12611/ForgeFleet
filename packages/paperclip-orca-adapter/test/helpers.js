// Shared pinned-context builder for adapter tests. Mirrors
// AdapterExecutionContext at pinned upstream tag v2026.1106.0:
// { runId, agent, runtime:{sessionId, sessionParams}, config, context,
//   onLog, onMeta?, onSpawn? }. onLog lines are captured for assertions.
export function makeCtx({
  cwd,
  taskId = 'T-1',
  runId = 'run-1',
  projectId = 'p1',
  config = {},
  context = {},
  sessionParams = null,
  sessionId = null,
  logs = null,
} = {}) {
  const captured = logs ?? [];
  return {
    ctx: {
      runId,
      agent: { id: 'agent-muse', companyId: 'forgefleet', name: 'muse', adapterConfig: config },
      runtime: { sessionId, sessionParams },
      config: {
        workerKind: 'muse',
        taskTitle: 'probe task',
        instruction: 'do the thing',
        contextManifestId: 'ctx-1',
        ...config,
      },
      context: { taskId, projectId, cwd, ...context },
      onLog: async (stream, chunk) => {
        captured.push(`[${stream}] ${chunk}`);
      },
    },
    logs: captured,
  };
}

export function nextRuntime(result) {
  return { sessionId: result.sessionParams?.sessionId ?? null, sessionParams: result.sessionParams };
}
