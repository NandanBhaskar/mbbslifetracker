# GitHub Actions Scheduler Setup (No Firebase Blaze)

This replaces scheduled Cloud Functions with GitHub Actions cron jobs.

## 1) Push this project to GitHub

Make sure these files are in your repo:

- `.github/workflows/notifications-cron.yml`
- `scheduler/package.json`
- `scheduler/run-notifications.js`

## 2) Create service account for Firestore + FCM

In Google Cloud Console (same Firebase project):

1. Go to **IAM & Admin -> Service Accounts**
2. Create service account (example: `mbbs-notifier-bot`)
3. Grant roles:
   - `Cloud Datastore User` (Firestore read/write)
   - `Firebase Admin SDK Administrator Service Agent` OR `Firebase Admin`
4. Create JSON key and download it

## 3) Add GitHub secret

In GitHub repo:

1. **Settings -> Secrets and variables -> Actions**
2. **New repository secret**
3. Name: `FIREBASE_SERVICE_ACCOUNT_JSON`
4. Value: paste the entire JSON content from the service account key file

## 4) Test manually

Go to **Actions -> MBBS Notifications Cron -> Run workflow**.

Use inputs:
- `job`: `ttly` or `weekly` or `exam` or `all`
- `dry_run`: set `true` first (safe test), then `false` for real sends

Check logs for:
- `[ttly] Notifications sent: X`
- `[weekly] Notifications sent: X`
- `[exam] Notifications sent: X`
- `[dry-run] uid=...` lines when `dry_run=true`

## 5) Cron schedule used

- TTLY: `30 14 * * *` (8:00 PM IST daily)
- Weekly rating: `30 13 * * 0` (7:00 PM IST Sundays)
- Exam reminders: `30 3 * * *` (9:00 AM IST daily)

## Notes

- FCM remains free.
- GitHub Actions free minutes usually cover this easily for small projects.
- If your repo is private, ensure your free minutes allowance is sufficient.
