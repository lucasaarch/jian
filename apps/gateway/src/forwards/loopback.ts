import { connect, type Socket } from 'node:net';

/** How long the server's port has to accept, in ms. */
const CONNECT_MS = 5000;

function dial(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: CONNECT_MS });
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', reject);
      // A reset later is the connection ending, which its close already tells.
      socket.on('error', () => {});
      resolve(socket);
    });
    socket.once('timeout', () => socket.destroy(new Error('timed out')));
    socket.once('error', reject);
  });
}

/**
 * A connection to a port of this machine's own loopback, and to no other host: the address is
 * fixed here, never taken from a caller. A dev server may listen on IPv4 or on IPv6 alone
 * (`localhost` resolves either way), so the IPv6 loopback is tried when IPv4 refuses.
 * The socket comes back paused: nothing is read until its stream is attached.
 */
export async function connectLoopback(port: number): Promise<Socket> {
  try {
    const socket = await dial('127.0.0.1', port);
    socket.pause();
    return socket;
  } catch (first) {
    const socket = await dial('::1', port).catch(() => {
      throw first;
    });
    socket.pause();
    return socket;
  }
}
