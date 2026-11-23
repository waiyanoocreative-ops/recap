import type { Response } from 'express';
import type { WebSocket } from 'ws';
import type { ProjectEventPayload } from '../../shared/projectTypes.ts';

const subscribers = new Map<string, Set<Response>>();
const wsSubscribers = new Map<string, Set<WebSocket>>();

export function subscribeProjectEvents(projectId: string, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let set = subscribers.get(projectId);
  if (!set) {
    set = new Set();
    subscribers.set(projectId, set);
  }
  set.add(res);

  const heartbeat = setInterval(() => {
    const payload: ProjectEventPayload = {
      type: 'heartbeat',
      timestamp: new Date().toISOString(),
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const active = subscribers.get(projectId);
    if (active) {
      active.delete(res);
      if (active.size === 0) {
        subscribers.delete(projectId);
      }
    }
  });
}

export function subscribeProjectWebSocket(projectId: string, ws: WebSocket): void {
  let set = wsSubscribers.get(projectId);
  if (!set) {
    set = new Set();
    wsSubscribers.set(projectId, set);
  }
  set.add(ws);

  const heartbeat = setInterval(() => {
    if (ws.readyState !== 1) return;
    try {
      const payload: ProjectEventPayload = {
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
      };
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore send errors on closing sockets
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    const active = wsSubscribers.get(projectId);
    if (active) {
      active.delete(ws);
      if (active.size === 0) {
        wsSubscribers.delete(projectId);
      }
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

export function emitProjectEvent(projectId: string, event: Omit<ProjectEventPayload, 'timestamp'>): void {
  const sseSet = subscribers.get(projectId);
  const wsSet = wsSubscribers.get(projectId);
  const hasSse = Boolean(sseSet && sseSet.size > 0);
  const hasWs = Boolean(wsSet && wsSet.size > 0);
  if (!hasSse && !hasWs) return;

  const fullEvent: ProjectEventPayload = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  const jsonPayload = JSON.stringify(fullEvent);

  if (sseSet && sseSet.size > 0) {
    const line = `data: ${jsonPayload}\n\n`;
    for (const res of sseSet) {
      try {
        res.write(line);
      } catch {
        // Ignore closed streams; cleanup occurs on close event
      }
    }
  }

  if (wsSet && wsSet.size > 0) {
    for (const ws of wsSet) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(jsonPayload);
      } catch {
        // Ignore closed WebSockets; cleanup occurs on close/error
      }
    }
  }
}
