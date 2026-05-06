const admin = require("firebase-admin");

const YEAR_MONTHS = [13, 13, 12, 13, 12];
const YEAR_IDS = ["y1", "y2", "y3a", "y3b", "int"];
const DRY_RUN = process.env.DRY_RUN === "true";

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON secret.");
  }
  return JSON.parse(raw);
}

function setupFirebase() {
  const serviceAccount = parseServiceAccount();
  admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "mbbs-life-tracker-db577",
});
  return {
    db: admin.firestore(),
    messaging: admin.messaging(),
  };
}

function weeksInMonths(m) {
  return Math.round((m * 365.25) / 12 / 7);
}

function getCurrentWeekNumber(startDateStr) {
  if (!startDateStr) return null;
  const start = new Date(startDateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffMs = now - start;
  if (diffMs < 0) return null;
  return Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function getWeekStartDate(startDateStr) {
  if (!startDateStr) return null;
  const start = new Date(startDateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffMs = now - start;
  const weeksElapsed = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() + weeksElapsed * 7);
  return weekStart;
}

function getCurrentWeekKey(startDateStr, overrides = {}) {
  if (!startDateStr) return null;
  const start = new Date(startDateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  let cursor = new Date(start);
  for (let i = 0; i < YEAR_IDS.length; i++) {
    const yearId = YEAR_IDS[i];
    const yearStart = overrides[yearId]
      ? new Date(overrides[yearId] + "T00:00:00")
      : new Date(cursor);
    const weeks = weeksInMonths(YEAR_MONTHS[i]);
    const yearEnd = new Date(yearStart);
    yearEnd.setDate(yearEnd.getDate() + weeks * 7);

    if (now >= yearStart && now < yearEnd) {
      const diffMs = now - yearStart;
      const weekIdx = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
      return { yearId, weekIdx, weekKey: `${yearId}_${weekIdx}` };
    }

    cursor = new Date(yearEnd);
  }

  return null;
}

async function sendToUser(db, messaging, uid, title, body, data = {}) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return 0;

  const userData = userDoc.data() || {};
  const tokens = userData.fcmTokens || [];
  if (!tokens.length) return 0;

  const message = {
    notification: { title, body },
    data,
    tokens,
  };

  if (DRY_RUN) {
    console.log(`[dry-run] uid=${uid} tokens=${tokens.length} title="${title}" action="${data.action || ""}"`);
    return tokens.length;
  }

  const response = await messaging.sendEachForMulticast(message);

  const invalidTokens = [];
  response.responses.forEach((resp, i) => {
    if (!resp.success) {
      const code = resp.error?.code;
      if (
        code === "messaging/invalid-registration-token" ||
        code === "messaging/registration-token-not-registered"
      ) {
        invalidTokens.push(tokens[i]);
      }
    }
  });

  if (invalidTokens.length > 0) {
    await db.collection("users").doc(uid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
    });
  }

  return response.successCount;
}

async function runTtlyNudge(db, messaging) {
  const usersSnapshot = await db.collection("users")
    .where("notificationsEnabled", "==", true)
    .get();

  let sent = 0;
  for (const doc of usersSnapshot.docs) {
    const uid = doc.id;
    const data = doc.data();
    const { startDate, weekNotes = {}, weekPhotos = {}, fcmTokens = [], overrides = {} } = data;
    if (!startDate || !fcmTokens.length) continue;

    const weekInfo = getCurrentWeekKey(startDate, overrides);
    if (!weekInfo) continue;

    const { weekKey, weekIdx } = weekInfo;
    const hasNote = !!(weekNotes[weekKey] && weekNotes[weekKey].trim());
    const hasPhoto = !!weekPhotos[weekKey];
    if (hasNote || hasPhoto) continue;

    const weekNum = getCurrentWeekNumber(startDate);
    sent += await sendToUser(
      db,
      messaging,
      uid,
      "How's Week " + weekNum + " going?",
      "Add a note or photo to capture this week before it passes.",
      {
        url: "/",
        action: "open_week",
        weekKey,
        weekIdx: String(weekIdx),
      }
    );
  }
  return sent;
}

async function runWeeklyRatingNudge(db, messaging) {
  const usersSnapshot = await db.collection("users")
    .where("notificationsEnabled", "==", true)
    .get();

  let sent = 0;
  for (const doc of usersSnapshot.docs) {
    const uid = doc.id;
    const data = doc.data();
    const { startDate, scores = {}, fcmTokens = [], overrides = {} } = data;
    if (!startDate || !fcmTokens.length) continue;

    const weekInfo = getCurrentWeekKey(startDate, overrides);
    if (!weekInfo) continue;

    const { weekKey, weekIdx } = weekInfo;
    const weekStart = getWeekStartDate(startDate);
    if (!weekStart) continue;

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const daysUntilEnd = Math.round((weekEnd - now) / (24 * 60 * 60 * 1000));
    if (daysUntilEnd > 1) continue;

    const alreadyRated = !!(scores[weekKey] && scores[weekKey] > 0);
    if (alreadyRated) continue;

    const weekNum = getCurrentWeekNumber(startDate);
    sent += await sendToUser(
      db,
      messaging,
      uid,
      "Week " + weekNum + " is ending - how was it?",
      "Rate your week before it slips away. Tap to open your rating.",
      {
        url: "/",
        action: "open_rating",
        weekKey,
        weekIdx: String(weekIdx),
      }
    );
  }
  return sent;
}

async function runExamCountdownReminder(db, messaging) {
  const usersSnapshot = await db.collection("users").get();

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  let sent = 0;
  for (const doc of usersSnapshot.docs) {
    const uid = doc.id;
    const data = doc.data();
    const { exams = [], fcmTokens = [] } = data;
    if (!fcmTokens.length || !exams.length) continue;

    for (const exam of exams) {
      if (!exam.date) continue;

      const examDate = new Date(exam.date + "T00:00:00");
      if (examDate < now) continue;

      const daysLeft = Math.round((examDate - now) / (24 * 60 * 60 * 1000));
      const shouldNotify =
        daysLeft <= 7 ||
        daysLeft === 14 ||
        daysLeft === 30 ||
        daysLeft === 60 ||
        daysLeft === 90;
      if (!shouldNotify) continue;

      let title;
      let body;
      if (daysLeft === 0) {
        title = `${exam.name} is today!`;
        body = "Good luck - you've got this.";
      } else if (daysLeft === 1) {
        title = `${exam.name} is tomorrow`;
        body = "Last chance to review. You're ready.";
      } else if (daysLeft <= 7) {
        title = `${daysLeft} days to ${exam.name}`;
        body = "The final stretch. Stay focused.";
      } else {
        title = `${daysLeft} days to ${exam.name}`;
        body = `${exam.name} on ${new Date(exam.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}. Keep going.`;
      }

      sent += await sendToUser(db, messaging, uid, title, body, {
        url: "/",
        action: "open_exams",
        examId: exam.id || exam.name,
      });
    }
  }
  return sent;
}

async function main() {
  const job = process.argv[2];
  if (!job || !["ttly", "weekly", "exam"].includes(job)) {
    throw new Error("Usage: node run-notifications.js <ttly|weekly|exam>");
  }

  const { db, messaging } = setupFirebase();
  console.log(`Mode: ${DRY_RUN ? "DRY_RUN" : "LIVE_SEND"}`);

  let sentCount = 0;
  if (job === "ttly") sentCount = await runTtlyNudge(db, messaging);
  if (job === "weekly") sentCount = await runWeeklyRatingNudge(db, messaging);
  if (job === "exam") sentCount = await runExamCountdownReminder(db, messaging);

  console.log(`[${job}] Notifications sent: ${sentCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
