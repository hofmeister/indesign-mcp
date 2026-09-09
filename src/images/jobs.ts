// Background jobs for image generation.
//
// An image takes anywhere from ten seconds to several minutes, while MCP clients give a tool call
// about a minute before they give up — and a client that gives up leaves the picture unreachable
// even though it was paid for. So every generation runs as a job: the tool waits a little for it,
// and hands back a job id if the picture is not ready yet. `wait_for_image` picks it up again, as
// often as needed, and the finished picture is kept until it is collected.

export type JobStatus = 'running' | 'done' | 'error';

export interface JobMeta {
  kind: 'generate' | 'edit';
  prompt: string;
  model: string;
  size: string;
}

export interface ImageJob<R> extends JobMeta {
  id: string;
  status: JobStatus;
  /** ms since the epoch. */
  startedAt: number;
  finishedAt?: number;
  result?: R;
  error?: string;
  /** Set once the caller has been given the finished result, so pruning can be told apart. */
  collected: boolean;
}

/** How long a finished job stays readable after it was collected. */
const KEEP_COLLECTED_MS = 10 * 60_000;
/** How long a finished job that nobody collected is kept. */
const KEEP_MS = 60 * 60_000;

let counter = 0;

export class ImageJobs<R> {
  private jobs = new Map<string, ImageJob<R>>();
  private settled = new Map<string, Promise<void>>();

  start(meta: JobMeta, work: () => Promise<R>): ImageJob<R> {
    this.prune();
    counter += 1;
    const id = `img-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const job: ImageJob<R> = { ...meta, id, status: 'running', startedAt: Date.now(), collected: false };
    this.jobs.set(id, job);
    this.settled.set(
      id,
      work().then(
        (result) => {
          job.result = result;
          job.status = 'done';
          job.finishedAt = Date.now();
        },
        (err: unknown) => {
          job.error = err instanceof Error ? err.message : String(err);
          job.status = 'error';
          job.finishedAt = Date.now();
        },
      ),
    );
    return job;
  }

  get(id: string): ImageJob<R> | undefined {
    return this.jobs.get(id);
  }

  list(): ImageJob<R>[] {
    return [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The job a bare `wait_for_image` should mean: the oldest one still running, else the newest. */
  pending(): ImageJob<R> | undefined {
    const all = this.list();
    return all.find((j) => j.status === 'running') ?? all.filter((j) => !j.collected).at(-1) ?? all.at(-1);
  }

  /**
   * Waits up to `timeoutMs` for the job to finish. Returns the job either way — a still-running one
   * simply comes back with status "running", and waiting again continues where this left off.
   */
  async wait(id: string, timeoutMs: number): Promise<ImageJob<R>> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No image job "${id}". It may have expired; start a new generation.`);
    const settled = this.settled.get(id);
    if (job.status === 'running' && settled && timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        // Do not hold the process open just for a wait that may be abandoned.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      await Promise.race([settled, deadline]);
      if (timer) clearTimeout(timer);
    }
    return job;
  }

  /** Marks the finished result as delivered, so it can be dropped sooner. */
  collect(id: string): void {
    const job = this.jobs.get(id);
    if (job && job.status !== 'running') job.collected = true;
  }

  private prune(now = Date.now()): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' || job.finishedAt === undefined) continue;
      const age = now - job.finishedAt;
      if (age > (job.collected ? KEEP_COLLECTED_MS : KEEP_MS)) {
        this.jobs.delete(job.id);
        this.settled.delete(job.id);
      }
    }
  }
}

export function elapsedText(job: ImageJob<unknown>): string {
  const ms = (job.finishedAt ?? Date.now()) - job.startedAt;
  return ms < 60_000
    ? `${Math.round(ms / 1000)} s`
    : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}
