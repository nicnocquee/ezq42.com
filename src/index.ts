import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import Bull from "bull";
import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import "dotenv/config";

const app = new Hono();

// Define the request schema
const requestSchema = z.object({
  email: z.string().email(),
  secretKey: z.string().optional(),
  delay: z.number().int().nonnegative().default(0),
  concurrency: z.number().int().positive().default(1),
  payload: z.object({
    url: z.string().url(),
    method: z
      .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
      .optional()
      .default("GET"),
    headers: z.record(z.string()).optional(),
    body: z.any().optional().optional(),
  }),
});

type JobData = z.infer<typeof requestSchema>;

// Create a map to store job queues for each URL
const jobQueues = new Map<string, Bull.Queue<JobData>>();

// Function to process a job
async function processJob(job: Bull.Job<JobData>) {
  const { url, method, headers, body } = job.data.payload;
  console.log(`Processing job ${job.id}`, body);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    return { status: response.status, url };
  } catch (error) {
    console.error(`Error processing job for ${url}:`, error);
    throw error;
  }
}

const jobHash = (
  email: string,
  payload: JobData["payload"],
  concurrency: number
) => {
  return createHash("sha256")
    .update(payload.url)
    .update(email)
    .update(concurrency.toString())
    .digest("hex");
};

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

app.post("/api/v1/job", zValidator("json", requestSchema), async (c) => {
  const jobData = c.req.valid("json");

  const { email, payload, concurrency } = jobData;

  const hash = jobHash(email, payload, concurrency);

  // Get or create a job queue for the URL
  let queue = jobQueues.get(hash);
  if (!queue) {
    queue = new Bull<JobData>(hash, REDIS_URL);
    queue.process(concurrency, processJob);
    queue.on("drained", () => {
      console.log(`Job queue ${hash} is drained`);
      jobQueues.delete(hash);
    });
    jobQueues.set(hash, queue);
  }

  // Add the job to the queue
  const job = await queue.add(jobData, {
    delay: jobData.delay * 1000,
    removeOnComplete: true,
    removeOnFail: true,
  });

  return c.json(
    { message: "Job added to queue", jobId: job.id, jobHash: hash },
    202
  );
});

// Route to check job queue
app.get("/api/v1/queues/:hash", async (c) => {
  const hash = c.req.param("hash");

  const queue = jobQueues.get(hash);
  if (!queue) {
    return c.json({ error: "Queue not found" }, 404);
  }

  const activeJobsCount = await queue.getActiveCount();

  return c.json({ jobHash: hash, activeJobsCount });
});

app.get("/api/v1/queues/count", async (c) => {
  const queuesCount = jobQueues.size;
  return c.json({ queuesCount });
});

app.get("/health", async (c) => {
  const healthQueue = new Bull<JobData>("health", REDIS_URL);
  await healthQueue.process("health", 1, async (job) => {
    return { status: "ok" };
  });
  return c.json({ status: "ok" });
});

// Start the server
const port = parseInt(process.env.PORT || "3000");
console.log(`Server is running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
