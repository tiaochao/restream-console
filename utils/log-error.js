function logError(context, err) {
  const msg = err instanceof Error ? err.message : String(err);
  const lines = (err instanceof Error && err.stack) ? err.stack.split('\n').slice(1, 3) : [];
  console.error(`[ERROR][${context}] ${msg}${lines.length ? '\n' + lines.join('\n') : ''}`);
}

module.exports = { logError };
