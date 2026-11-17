// main.ts — process entrypoint for the git forge.
//
// This file owns only the trial lifecycle; every route the forge serves
// lives behind createApp() in app.ts. The harness expects, in order:
//   1. the forge's HTTP server listening on an ephemeral port,
//   2. a POST to $MAKEFUN_ENV_URL/register announcing that port,
//   3. this process polling $MAKEFUN_ENV_URL/done until the harness
//      reports the trial finished, then exiting with status 0.
// The harness base URL arrives in the MAKEFUN_ENV_URL variable.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envBase === '') {
  // Without the harness there is nothing to register with: exit at once.
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

/** One register or poll request may take this long before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Waits between retries grow from the first value up to the cap. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after the given number of failed attempts: doubling, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

async function announce(port: number): Promise<void> {
  // Registration is how the suite finds the forge. A 200 accepts us and
  // a 409 means an earlier register already won — either way this process
  // goes on to wait for done. A 400 or 405 is a contract error and ends
  // the program; anything else (the env may still be starting) retries
  // with a growing wait, for as long as it takes.
  for (let attempt = 0; ; attempt += 1) {
    let reply: Response | null = null;
    try {
      reply = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      reply = null;
    }
    if (reply !== null) {
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  // Poll until the harness says the trial is over, and never return
  // before that. A failed or slow poll is not fatal: the harness may
  // still be starting, so wait with the same backoff and ask again.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${envBase}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (reply.ok) {
        const state = (await reply.json()) as { done?: unknown };
        if (state.done === true) return;
      }
    } catch {
      // No answer yet; fall through and poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();

  // Port 0 asks the kernel for an ephemeral port, as the rules require.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }

  await announce(address.port);
  await waitUntilDone();
  // The trial is finished: close the server, then return so the
  // process exits 0 below.
  server.close();
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
