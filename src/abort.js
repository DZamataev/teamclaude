/** Combine an optional caller cancellation signal with a bounded timeout. */
export function timeoutSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });

  let timer = null;
  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
