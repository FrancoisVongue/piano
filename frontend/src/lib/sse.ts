import { useCanvasStore } from '@/domain/canvas/store';
import { SSE_CONFIG } from '@/config';

let eventSource: EventSource | null = null;
let activeClientId: string | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;

const MAX_RETRY_DELAY = 30_000;

function attachListeners(es: EventSource) {
  es.addEventListener('run.update', (event) => {
    const data = JSON.parse(event.data);
    useCanvasStore.getState().updateNodeContent(data.noteId, '', data.content);
    useCanvasStore.getState().setNodeRunning(data.noteId, true);
  });

  es.addEventListener('run.complete', (event) => {
    const data = JSON.parse(event.data);
    useCanvasStore.getState().updateNodeContent(data.noteId, '', data.content);
    useCanvasStore.getState().setNodeRunning(data.noteId, false);
  });
}

function clearRetry() {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
}

function scheduleReconnect() {
  if (retryTimeout || !activeClientId) return;
  retryTimeout = setTimeout(() => {
    retryTimeout = null;
    if (activeClientId) connect(activeClientId);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

function connect(clientId: string) {
  eventSource?.close();

  const es = new EventSource(`${SSE_CONFIG.BASE_URL}/events?clientId=${clientId}`);
  eventSource = es;

  es.onopen = () => {
    retryDelay = 1000;
  };

  es.onerror = () => {
    es.close();
    if (eventSource === es) {
      eventSource = null;
      scheduleReconnect();
    }
  };

  attachListeners(es);
}

export const connectToSSE = (clientId: string) => {
  if (activeClientId === clientId && eventSource && eventSource.readyState !== EventSource.CLOSED) return;

  activeClientId = clientId;
  retryDelay = 1000;
  clearRetry();
  connect(clientId);
};

export const disconnectFromSSE = () => {
  activeClientId = null;
  clearRetry();
  eventSource?.close();
  eventSource = null;
};
