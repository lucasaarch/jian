import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';

/**
 * A query on the client, rather than on the transaction, made while that transaction is open.
 * PGlite runs both behind one lock that the transaction holds until it ends, so the query waits
 * for the transaction, the transaction for the query, and every later request behind them.
 */
export class QueryOutsideTransaction extends Error {
  constructor(call: string, opened: Error) {
    super(
      `A database ${call} was made outside the open transaction, from inside it. On the one ` +
        'connection of this database it waits for the transaction, which waits for it, and the ' +
        'gateway stops answering. Make it on the transaction, or before or after it.',
    );
    this.name = 'QueryOutsideTransaction';
    // The query's own stack ends in the database library, past an await; where the transaction
    // was opened names the code at fault.
    const where = opened.stack?.split('\n').slice(1).join('\n') ?? '';
    this.stack = `${this.stack}\nThe transaction it waits for was opened:\n${where}`;
  }
}

/** The transaction whose body this async context runs in; `open` is false once it ended. */
type Body = { open: boolean; opened: Error };

/**
 * Refuses the deadlock a single connection allows: every query, exec and transaction made on
 * `client` itself while a transaction's own body runs and that transaction is open fails at once,
 * so the body's transaction rolls back and the gateway keeps answering. `outside` hears of each
 * first, with where it came from, since a `catch` on the way may swallow the error. Work the body
 * started and left running is refused only while the transaction is still open: after, it runs as
 * it should.
 */
export class SingleConnection {
  private readonly bodies = new AsyncLocalStorage<Body>();

  constructor(client: PGlite, outside: (error: QueryOutsideTransaction) => void) {
    const watched = <Call extends (...args: never[]) => unknown>(name: string, call: Call) =>
      ((...args: Parameters<Call>) => {
        const body = this.bodies.getStore();
        if (body?.open) {
          const error = new QueryOutsideTransaction(name, body.opened);
          outside(error);
          // Rejected as the call would have: its callers expect a promise.
          return Promise.reject(error);
        }
        return call(...args);
      }) as Call;

    client.query = watched('query', client.query.bind(client));
    client.exec = watched('exec', client.exec.bind(client));
    client.transaction = watched('transaction', client.transaction.bind(client));
  }

  /**
   * Where a transaction is opened: taken as the store is asked for it, since by the time its body
   * runs the caller is no longer on the stack. Cheap: the trace is only formatted if read.
   */
  opening(): Error {
    return new Error('Transaction opened');
  }

  /** Runs a transaction's body, as the context whose queries on the client are refused. */
  async body<T>(opened: Error, run: () => Promise<T>): Promise<T> {
    const body: Body = { open: true, opened };
    try {
      return await this.bodies.run(body, run);
    } finally {
      body.open = false;
    }
  }
}
