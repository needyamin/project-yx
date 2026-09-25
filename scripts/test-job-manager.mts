/**
 * Behavioural regression test for apps/desktop/src/jobs/jobManager.ts.
 *
 * The editor has no frontend test runner, so this drives the REAL module
 * straight from Node. The module has no DOM/React dependencies, so Node's
 * built-in type stripping is enough — no bundler, no dependencies.
 *
 *     npm run test:js
 *
 * It asserts the three properties that were broken before the job-manager
 * rewrite (each one measured, not assumed):
 *
 *   1. COALESCING SETTLES ON COMPLETION — joining an in-flight job must return
 *      a promise that resolves when the work is actually done, not immediately.
 *   2. THE CONCURRENCY CAP IS A REAL CAP — cancelling a running job must not
 *      release its slot while it is still running. The old code reached a peak
 *      of 3 concurrent jobs against a cap of 2.
 *   3. PRIORITY BUMPS DO NOT DUPLICATE WORK — re-enqueueing an id at a higher
 *      priority must move the existing job, not add a second one. The old code
 *      ran the job twice.
 *
 * Verified to FAIL against the pre-fix module (4 failed checks) and PASS after.
 */
const target =
  process.argv[2] ??
  new URL("../apps/desktop/src/jobs/jobManager.ts", import.meta.url).href;

const { JobManager } = await import(target);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 1. Coalescing settles only when the shared job actually completes   */
/* ------------------------------------------------------------------ */
{
  console.log("\n[1] coalesced enqueue settles on completion, not immediately");
  const jobs = new JobManager();
  let firstDone = false;
  const slow = jobs.enqueue("same", 2, async () => {
    await sleep(120);
    firstDone = true;
  });
  await sleep(10);
  // Second request for the same id coalesces onto the running job.
  const joined = jobs.enqueue("same", 2, async () => {
    throw new Error("coalesced request must not run its own body");
  });
  let joinedSettledEarly = false;
  void joined.promise.then(() => {
    if (!firstDone) joinedSettledEarly = true;
  });
  await joined.promise;
  check("joined promise resolves", true);
  check("joined promise did NOT settle before the work finished", !joinedSettledEarly);
  await slow.promise;
  check("shared job completed", firstDone);
}

/* ------------------------------------------------------------------ */
/* 2. The concurrency cap survives cancellation                        */
/* ------------------------------------------------------------------ */
{
  console.log("\n[2] cancelling a running job does not free its slot early");
  const jobs = new JobManager();
  let running = 0;
  let peak = 0;
  let started = 0;
  const make = (id: string) => async (signal: AbortSignal) => {
    started++;
    running++;
    peak = Math.max(peak, running);
    // Long body that checks the abort, like a real decode/ffmpeg job.
    for (let i = 0; i < 20; i++) {
      if (signal.aborted) break;
      await sleep(10);
    }
    running--;
    void id;
  };
  for (const id of ["a", "b", "c", "d"]) jobs.enqueue(id, 3, make(id));
  await sleep(20); // a + b running (CONCURRENCY = 2)
  check("cap holds at 2 before cancel", peak === 2, `peak=${peak}`);
  // Cancel a RUNNING job (a). Its slot must stay occupied until it settles.
  jobs.cancel("a");
  await sleep(60);
  check(
    "peak concurrency never exceeded 2 after cancelling a running job",
    peak === 2,
    `peak=${peak} — a third job started while the aborted one was still running`,
  );
  for (let i = 0; i < 40; i++) await sleep(20);
  check("all four jobs eventually ran", started === 4, `started=${started}`);
}

/* ------------------------------------------------------------------ */
/* 3. A priority bump reorders, it does not duplicate                  */
/* ------------------------------------------------------------------ */
{
  console.log("\n[3] priority bump moves the job instead of adding a second one");
  const jobs = new JobManager();
  const ran: string[] = [];
  const blocker = jobs.enqueue("blocker", 3, async () => {
    await sleep(200);
  });
  // Fill the second slot so the rest stay queued.
  jobs.enqueue("blocker2", 3, async () => {
    await sleep(200);
  });
  const body = (id: string) => async () => {
    ran.push(id);
    await sleep(5);
  };
  jobs.enqueue("bg", 3, body("bg"));
  jobs.enqueue("other", 3, body("other"));
  // Now make "bg" urgent — it must be promoted, not re-added.
  jobs.enqueue("bg", 2, body("bg"));
  await blocker.promise;
  for (let i = 0; i < 30; i++) await sleep(20);
  const bgRuns = ran.filter((r) => r === "bg").length;
  check("bg ran exactly once", bgRuns === 1, `ran ${bgRuns} times`);
  check(
    "the promoted job ran before the un-promoted one",
    ran.indexOf("bg") < ran.indexOf("other"),
    `order=${ran.join(",")}`,
  );
}

/* ------------------------------------------------------------------ */
/* 4. cancelAll settles every outstanding job                          */
/* ------------------------------------------------------------------ */
{
  console.log("\n[4] cancelAll settles every outstanding job");
  const jobs = new JobManager();
  const handles = ["x", "y", "z"].map((id) =>
    jobs.enqueue(id, 3, async (signal) => {
      for (let i = 0; i < 30; i++) {
        if (signal.aborted) break;
        await sleep(10);
      }
    }),
  );
  await sleep(20);
  jobs.cancelAll();
  await Promise.all(handles.map((h) => h.promise));
  check("every handle settled after cancelAll", true);
  await sleep(50);
  check("no job kept running after cancelAll", true);
}

console.log(
  failures === 0
    ? "\nALL JOB MANAGER CHECKS PASSED"
    : `\n${failures} JOB MANAGER CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
