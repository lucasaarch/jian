/**
 * What of a gateway's answer reaches the window. The window keeps no cookie of any gateway: the
 * token is the only credential. And no Origin-Agent-Cluster: Electron 45 dies on a CHECK when a
 * sandboxed frame it loads through jian:// commits with it, and every Artifact opens in one, so
 * an older gateway that still sends it must not take the app down.
 */
export function answerHeaders(gateway: Headers): Headers {
  const answered = new Headers(gateway);
  answered.delete('set-cookie');
  answered.delete('origin-agent-cluster');
  return answered;
}
