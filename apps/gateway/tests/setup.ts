import { afterEach } from 'vitest';
import { outsideTransactions } from './helpers/database.js';

// A query outside its transaction hangs the desktop app's gateway for good; the test store refuses
// it, and the test fails here even when the code under test caught the error.
afterEach(() => {
  const refused = outsideTransactions.splice(0);
  // In the message: the runner rebuilds a stack from its frames and drops where the transaction
  // was opened, which is what names the code at fault.
  if (refused.length) throw new Error(refused.map((error) => error.stack).join('\n\n'));
});
