import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import Bull from "bull";
import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { GeneralConfigType, rateLimiter } from "hono-rate-limiter";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createClient } from "redis";
import "dotenv/config";

const REDIS_JOBS_URL = process.env.REDIS_JOBS_URL || "redis://localhost:6379";
const REDIS_APP_URL = process.env.REDIS_APP_URL || "redis://localhost:6379";
const GUMROAD_PRODUCT_ID = process.env.GUMROAD_PRODUCT_ID || "";
const SUPER_SECRET_KEY = process.env.SUPER_SECRET_KEY || "";
const PORT = process.env.PORT || "3000";
const GUMROAD_VERIFY_LICENSE_URL = process.env.GUMROAD_VERIFY_LICENSE_URL || "";

const redisAppClient = createClient({ url: REDIS_APP_URL });
redisAppClient.on("error", (err) => console.log("Redis App Client Error", err));

const app = new Hono();

const defaultConfig = {
  windowMs: 60 * 1000, // 1 minute
  limit: 6, // Limit each IP to 6 requests per `window` (here, per 1 minute).
  standardHeaders: "draft-6", // draft-6: `RateLimit-*` headers; draft-7: combined `RateLimit` header,
  message:
    "Too many requests, please try again later. Free usage is limited to 6 requests per minute.",
  keyGenerator: async (c) => {
    const body = await c.req.json();
    const email = body?.email || "";

    const xForwardedFor = c.req.header("x-forwarded-for") || "";

    const info = getConnInfo(c);
    const ipAddress = info.remote.address || "";

    return `${email}-${xForwardedFor}-${ipAddress}`;
  }, // Method to generate custom identifiers for clients.
  skip: async (c) => {
    if (c.req.path !== "/api/v1/job") return true;
    const body = await c.req.json();
    const apiKey = body?.apiKey || "";
    const skip = apiKey === SUPER_SECRET_KEY;
    if (skip) console.log(`Skipping rate limit because of super secret key`);
    return skip;
  },
} satisfies Parameters<typeof rateLimiter>[0];

const freeLimiter = rateLimiter(defaultConfig);
const paidLimiter = rateLimiter({
  ...defaultConfig,
  limit: 120,
  keyGenerator: async (c) => {
    const body = await c.req.json();
    const apiKey = body?.apiKey || "";
    return apiKey;
  },
  skip: async (c) => {
    if (c.req.path !== "/api/v1/job") return true;
    const body = await c.req.json();
    const apiKey = body?.apiKey || "";
    const skip = apiKey === SUPER_SECRET_KEY;
    if (skip) console.log(`Skipping rate limit because of super secret key`);
    return skip;
  },
});
const publicLimiter = rateLimiter({
  ...defaultConfig,
  limit: 10,
  keyGenerator: async (c) => {
    const xForwardedFor = c.req.header("x-forwarded-for") || "";

    const info = getConnInfo(c);
    const ipAddress = info.remote.address || "";

    return `${xForwardedFor}-${ipAddress}`;
  },
});

// Apply the rate limiting middleware to all requests.
app.use(async (c, next) => {
  if (c.req.path !== "/api/v1/job") {
    return publicLimiter(c, next);
  }
  const body = await c.req.json();
  const email = body?.email || "";
  const apiKey = body?.apiKey || "";
  const isPaid = await checkApiKey(email, apiKey);
  if (isPaid) {
    return paidLimiter(c, next);
  }

  return freeLimiter(c, next);
});

// Define the request schema
const requestSchema = z.object({
  email: z.string().email(),
  apiKey: z.string().optional(),
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
      signal: AbortSignal.timeout(15 * 1000),
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

app.post("/api/v1/job", zValidator("json", requestSchema), async (c) => {
  const jobData = c.req.valid("json");

  const { email, payload, concurrency, apiKey } = jobData;

  const isValid = await checkApiKey(email, apiKey || "");
  if (!isValid) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  const hash = jobHash(email, payload, concurrency);

  // Get or create a job queue for the URL
  let queue = jobQueues.get(hash);
  if (!queue) {
    queue = new Bull<JobData>(hash, REDIS_JOBS_URL);
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

  // increment the total job count and save it to redis
  await recordJobAndGetCounts();

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
  if (!GUMROAD_PRODUCT_ID) {
    console.error("GUMROAD_PRODUCT_ID is not set");
    return c.status(500);
  }

  const healthQueue = new Bull<JobData>("health", REDIS_JOBS_URL);
  await healthQueue.process("health", 1, async (job) => {
    return { status: "ok" };
  });

  await redisAppClient.set("health:last-updated", new Date().toISOString());

  return c.json({ status: "ok" });
});

app.get("/total-jobs", async (c) => {
  const jobCounts = await getJobCounts();
  return c.json({ jobCounts: JSON.parse(JSON.stringify(jobCounts)) });
});

app.post(`/activate-key`, async (c) => {
  const { email, apiKey } = await c.req.json();
  const isValid = await checkApiKey(email, apiKey);
  if (!isValid) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  await redisAppClient.set(`api-key:${email}`, apiKey);

  return c.json({ message: "API key activated" });
});

// Start the server
const port = parseInt(PORT || "3000");

serve(
  {
    fetch: app.fetch,
    port,
  },
  async (info) => {
    await redisAppClient.connect();
    console.log(`Listening on http://localhost:${info.port}`);
  }
);

interface JobCounts {
  day: {
    count: number;
    range: string;
  };
  week: {
    count: number;
    range: string;
  };
  month: {
    count: number;
    range: string;
  };
  total: {
    count: number;
    range: string;
  };
}

// Define the structure of date formats
interface DateFormats {
  day: string;
  week: string;
  month: string;
}

function getDateFormats(): DateFormats {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  const weekNumber = getWeekNumber(now);

  return {
    day: `${year}-${month}-${date}`,
    week: `${year}-W${weekNumber}`,
    month: `${year}-${month}`,
  };
}

function getWeekNumber(d: Date): string {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
  }
  const weekNumber =
    1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
  return String(weekNumber).padStart(2, "0");
}

export async function recordJobAndGetCounts(): Promise<boolean> {
  const { day, week, month } = getDateFormats();
  const dayKey = `jobs:day:${day}`;
  const weekKey = `jobs:week:${week}`;
  const monthKey = `jobs:month:${month}`;
  const totalKey = "jobs:total";

  try {
    // Increment counters for each time period
    const results = await redisAppClient
      .multi()
      .incr(dayKey)
      .incr(weekKey)
      .incr(monthKey)
      .incr(totalKey)
      .exec();

    if (!results) {
      throw new Error("Failed to increment counters");
    }

    // Set expiration for day, week, and month keys
    await redisAppClient
      .multi()
      .expire(dayKey, 86400) // 24 hours
      .expire(weekKey, 604800) // 7 days
      .expire(monthKey, 2592000) // 30 days
      .exec();

    if (!results || results.length < 4) {
      throw new Error("Failed to increment counters");
    }

    return true;
  } catch (error) {
    console.error("Error recording job counts:", error);
    throw error;
  }
}

export async function getJobCounts(): Promise<JobCounts> {
  const { day, week, month } = getDateFormats();
  const dayKey = `jobs:day:${day}`;
  const weekKey = `jobs:week:${week}`;
  const monthKey = `jobs:month:${month}`;
  const totalKey = "jobs:total";

  console.log(`Getting job counts for ${dayKey}, ${weekKey}, ${monthKey}`);
  try {
    const results = await redisAppClient
      .multi()
      .get(dayKey)
      .get(weekKey)
      .get(monthKey)
      .get(totalKey)
      .exec();

    const [day, week, month, total] = results as [
      string,
      string,
      string,
      string
    ];

    return {
      day: {
        count: parseInt(day),
        range: day,
      },
      week: {
        count: parseInt(week),
        range: week,
      },
      month: {
        count: parseInt(month),
        range: month,
      },
      total: {
        count: parseInt(total),
        range: "all",
      },
    };
  } catch (error) {
    console.error("Error getting job counts:", error);
    throw error;
  }
}

const checkApiKey = async (email: string, apiKey: string) => {
  if (!apiKey) {
    return false;
  }
  if (apiKey === SUPER_SECRET_KEY) {
    return true;
  }
  const existingKey = await redisAppClient.get(`api-key:${email}`);
  if (existingKey === apiKey) {
    return true;
  } else {
    // https://help.gumroad.com/article/76-license-keys
    const url = GUMROAD_VERIFY_LICENSE_URL;
    const params = new URLSearchParams({
      product_id: GUMROAD_PRODUCT_ID || "",
      license_key: apiKey,
    });

    const response = await fetch(url, {
      method: "POST",
      body: params,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const data: any = await response.json();

    console.log(`Got data from gumroad: ${JSON.stringify(data, null, 2)}`);

    const {
      success,
      purchase: {
        subscription_ended_at,
        subscription_cancelled_at,
        subscription_failed_at,
      },
    } = data;
    if (
      success &&
      !subscription_ended_at &&
      !subscription_cancelled_at &&
      !subscription_failed_at
    ) {
      await redisAppClient.set(`api-key:${email}`, apiKey);
      return true;
    }
  }

  return false;
};

/*
License object from gumroad:

{
  "success": true,
  "uses": 3,
  "purchase": {
    "seller_id": "kL0psVL2admJSYRNs-OCMg==",
    "product_id": "32-nPAicqbLj8B_WswVlMw==",
    "product_name": "licenses demo product",
    "permalink": "QMGY",
    "product_permalink": "https://sahil.gumroad.com/l/pencil",
    "email": "customer@example.com",
    "price": 0,
    "gumroad_fee": 0,
    "currency": "usd",
    "quantity": 1,
    "discover_fee_charged": false,
    "can_contact": true,
    "referrer": "direct",
    "card": {
      "expiry_month": null,
      "expiry_year": null,
      "type": null,
      "visual": null
    },
    "order_number": 524459935,
    "sale_id": "FO8TXN-dbxYaBdahG97Y-Q==",
    "sale_timestamp": "2021-01-05T19:38:56Z",
    "purchaser_id": "5550321502811",
    "subscription_id": "GDzW4_aBdQc-o7Gbjng7lw==",
    "variants": "",
    "license_key": "85DB562A-C11D4B06-A2335A6B-8C079166",
    "is_multiseat_license": false,
    "ip_country": "United States",
    "recurrence": "monthly",
    "is_gift_receiver_purchase": false,
    "refunded": false,
    "disputed": false,
    "dispute_won": false,
    "id": "FO8TXN-dvaYbBbahG97a-Q==",
    "created_at": "2021-01-05T19:38:56Z",
    "custom_fields": [],
    "chargebacked": false,
    "subscription_ended_at": null,
    "subscription_cancelled_at": null,
    "subscription_failed_at": null
  }
}

*/
