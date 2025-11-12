# PolAI Backend

This repository contains the PolAI backend (Privacy Policy Analysis API). Below are quick instructions to deploy to Render.com.

## Quick start (Render)

1. Push your repo to GitHub (if not already).
2. In Render, create a new Web Service and connect the GitHub repo.
   - Branch: `main`
   - Environment: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health check path: `/api/health`

3. Set environment variables in the Render dashboard (Service -> ENV & Secrets):
   - `AI_PROVIDER` = `mistral` or `openai`
   - `MISTRAL_API_KEY` = <your key> (only if using Mistral)
   - `OPENAI_API_KEY` = <your key> (only if using OpenAI)
   - `NODE_ENV` = `production`
   - `DB_PATH` = `/data/polai.db` (if you attach a Persistent Disk and plan to continue using SQLite)

4. Persistence options:
   - Recommended: Create a managed Postgres instance and set `DATABASE_URL` (update code to use Postgres).
   - If you prefer to keep SQLite, attach a Render Persistent Disk to your Web Service and set `DB_PATH` to `/data/polai.db`.

5. Deploy and check logs. Test the health endpoint:

```powershell
Invoke-RestMethod -Method Get -Uri https://<your-service>.onrender.com/api/health
```

## Notes
- Do NOT commit API keys to the repo. Use Render's secrets.
- `render.yaml` is included as a manifest for convenience — add secrets via the dashboard.
- The app will use `DB_PATH` if provided; otherwise it will default to `./polai.db`.

If you want, I can also:
- Update code to migrate from SQLite to Postgres and add a `DATABASE_URL` config.
- Create a small health-check script or a startup migration.
