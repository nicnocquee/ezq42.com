# Getting Started

- `npm install`
- `docker-compose -f docker-compose.dev.yml up`
- `npm run dev`

```bash
curl -X POST "https://ezq42.com/api/v1/job" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "hi@example.com",
    "payload": {
      "url": "https://nico.fyi"
    }
  }'
```
