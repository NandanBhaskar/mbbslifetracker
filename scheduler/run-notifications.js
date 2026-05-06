const admin = require("firebase-admin");
const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const job = process.argv[2];
  console.log("Job:", job);
  console.log("Mode:", DRY_RUN ? "DRY_RUN" : "LIVE_SEND");

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  console.log("Secret length:", raw ? raw.length : 0);
  if (!raw) throw new Error("MISSING SECRET");

  const serviceAccount = JSON.parse(raw);
  console.log("Project ID:", serviceAccount.project_id);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });

  const db = admin.firestore();
  console.log("Firestore created, attempting query...");

  const snap = await db.collection("users").limit(1).get();
  console.log("SUCCESS — docs:", snap.size);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});