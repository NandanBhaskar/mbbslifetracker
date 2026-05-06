const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// ── Helper: send notification to all FCM tokens for a user ────────
async function sendToUser(uid, title, body, data = {}) {
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return;
  const userData = userDoc.data();
  const tokens = userData.fcmTokens || [];
  if (!tokens.length) return;

  const message = {
    notification: { title, body },
    data,
    tokens,
  };

  const response = await messaging.sendEachForMulticast(message);

  // Clean up invalid tokens
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
}

// ── Helper: get the current MBBS week number (Week X of their journey) ──
function getCurrentWeekNumber(startDateStr) {
  if (!startDateStr) return null;
  const start = new Date(startDateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffMs = now - start;
  if (diffMs < 0) return null;
  return Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
}

// ── Helper: get the start-of-week date (Monday or configured start day) ──
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

// ── Helper: get a week key like "y1_0", "y2_5" etc. for the current week ──
// This mirrors the logic in computeYearMeta in the frontend
const YEAR_MONTHS = [13, 13, 12, 13, 12]; // y1, y2, y3a, y3b, int
const YEAR_IDS = ["y1", "y2", "y3a", "y3b", "int"];

function weeksInMonths(m) {
  return Math.round((m * 365.25) / 12 / 7);
}

function getCurrentWeekKey(startDateStr, overrides = {}) {
  if (!startDateStr) return null;
  const start = new Date(startDateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  let cursor = new Date(start);
  for (let i = 0; i < YEAR_IDS.length; i++) {
    const yearId = YEAR_IDS[i];
    const yearStart = overrides[yearId] ? new Date(overrides[yearId] + "T00:00:00") : new Date(cursor);
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


// ═══════════════════════════════════════════════════════════
// FUNCTION 1: Daily TTLY nudge
// Runs every day at 8:00 PM IST (2:30 PM UTC)
// Sends if current week has no note AND no photo yet
// ═══════════════════════════════════════════════════════════
exports.ttlyNudge = functions.pubsub
  .schedule("30 14 * * *")   // 2:30 PM UTC = 8:00 PM IST
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    const usersSnapshot = await db.collection("users")
      .where("notificationsEnabled", "==", true)
      .get();

    const promises = usersSnapshot.docs.map(async (doc) => {
      const uid = doc.id;
      const data = doc.data();
      const { startDate, weekNotes = {}, weekPhotos = {}, fcmTokens = [], overrides = {} } = data;

      if (!startDate || !fcmTokens.length) return;

      const weekInfo = getCurrentWeekKey(startDate, overrides);
      if (!weekInfo) return;

      const { weekKey, weekIdx } = weekInfo;
      const hasNote = !!(weekNotes[weekKey] && weekNotes[weekKey].trim());
      const hasPhoto = !!weekPhotos[weekKey];

      // Only nudge if nothing logged yet this week
      if (hasNote || hasPhoto) return;

      const weekNum = getCurrentWeekNumber(startDate);
      await sendToUser(
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
    });

    await Promise.all(promises);
    return null;
  });


// ═══════════════════════════════════════════════════════════
// FUNCTION 2: Weekly rating nudge (end-of-week Sunday evening)
// Runs every Sunday at 7:00 PM IST (1:30 PM UTC)
// Calculates the user's "week end day" based on their start date
// and nudges them to rate the ending week
// ═══════════════════════════════════════════════════════════
exports.weeklyRatingNudge = functions.pubsub
  .schedule("30 13 * * 0")   // 1:30 PM UTC Sunday = 7:00 PM IST Sunday
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    const usersSnapshot = await db.collection("users")
      .where("notificationsEnabled", "==", true)
      .get();

    const promises = usersSnapshot.docs.map(async (doc) => {
      const uid = doc.id;
      const data = doc.data();
      const { startDate, scores = {}, fcmTokens = [], overrides = {} } = data;

      if (!startDate || !fcmTokens.length) return;

      const weekInfo = getCurrentWeekKey(startDate, overrides);
      if (!weekInfo) return;

      const { weekKey, weekIdx } = weekInfo;

      // Check if week end day is near (within the next 2 days)
      // The week ends 7 days after its start
      const weekStart = getWeekStartDate(startDate);
      if (!weekStart) return;
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const daysUntilEnd = Math.round((weekEnd - now) / (24 * 60 * 60 * 1000));

      // Only nudge on the last day or the day before
      if (daysUntilEnd > 1) return;

      const alreadyRated = !!(scores[weekKey] && scores[weekKey] > 0);
      if (alreadyRated) return;

      const weekNum = getCurrentWeekNumber(startDate);
      await sendToUser(
        uid,
        "Week " + weekNum + " is ending — how was it?",
        "Rate your week before it slips away. Tap to open your rating.",
        {
          url: "/",
          action: "open_rating",
          weekKey,
          weekIdx: String(weekIdx),
        }
      );
    });

    await Promise.all(promises);
    return null;
  });


// ═══════════════════════════════════════════════════════════
// FUNCTION 3: Daily exam countdown reminder
// Runs every day at 9:00 AM IST (3:30 AM UTC)
// Sends a reminder for each upcoming exam the user has added
// ═══════════════════════════════════════════════════════════
exports.examCountdownReminder = functions.pubsub
  .schedule("30 3 * * *")   // 3:30 AM UTC = 9:00 AM IST
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    const usersSnapshot = await db.collection("users")
      .where("notificationsEnabled", "==", true)
      .get();

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const promises = usersSnapshot.docs.map(async (doc) => {
      const uid = doc.id;
      const data = doc.data();
      const { exams = [], fcmTokens = [] } = data;

      if (!fcmTokens.length || !exams.length) return;

      const notifPromises = exams
        .filter((exam) => {
          if (!exam.date) return false;
          const examDate = new Date(exam.date + "T00:00:00");
          return examDate >= now; // Only upcoming exams
        })
        .map(async (exam) => {
          const examDate = new Date(exam.date + "T00:00:00");
          const daysLeft = Math.round((examDate - now) / (24 * 60 * 60 * 1000));

          // Only notify at meaningful milestones to avoid notification fatigue:
          // Every day in the last 7 days, weekly at 30/60/90 days out
          const shouldNotify =
            daysLeft <= 7 ||
            daysLeft === 14 ||
            daysLeft === 30 ||
            daysLeft === 60 ||
            daysLeft === 90;

          if (!shouldNotify) return;

          let title, body;
          if (daysLeft === 0) {
            title = `${exam.name} is today!`;
            body = "Good luck — you've got this.";
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

          await sendToUser(uid, title, body, {
            url: "/",
            action: "open_exams",
            examId: exam.id || exam.name,
          });
        });

      await Promise.all(notifPromises);
    });

    await Promise.all(promises);
    return null;
  });