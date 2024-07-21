# About

The simple background job queue service for serverless functions like Next.js app running on Vercel.

You just need to

- create an API end point or a Route handler in your Next.js app
- implement the long running job logic in it.
- Then you add the job to EZQ42 by specifying the URL to the end point with the data you want to pass to it.
- EZQ42 will then call the end point along with the data.

Check out the example project [here](https://github.com/nicnocquee/ezq42example).

# Usage

Free use (rate limit is 6 requests per minute):

```bash
curl -X POST "https://ezq42.com/api/v1/job" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "hi@example.com",
    "payload": {
      "url": <the URL to to run the job on>
    }
  }'
```

Note: The `email` field is mandatory.

Paid use (rate limit is 120 requests per minute):

- Get the license key from [Gumroad](https://nicopr.gumroad.com/l/gphro)
- Activate the key by sending a POST request to `https://ezq42.com/activate-key`

```bash
curl -X POST "https://ezq42.com/activate-key" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "hi@example.com",
    "apiKey": <the license key>
  }'
```

- Use the license key in the `apiKey` field

```bash
curl -X POST "https://ezq42.com/api/v1/job" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "hi@example.com",
    "apiKey": <the secret key>,
    "payload": {
      "url": <the URL to to run the job on>
    }
  }'
```

# Development

- `npm install`
- `cp .env.example .env`. Fill up the `.env` file. Set `SUPER_SECRET_KEY` to something to bypass rate limiting.
- `docker-compose -f docker-compose.dev.yml up`
- `npm run dev`
