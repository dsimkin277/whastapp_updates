 /**
 * Auto WhatsApp Status
 * Runs hourly via GitHub Actions. Posts one image to WhatsApp Status every
 * 48 hours, but only during a valid working window per the schedule sheet.
 */
import { google } from "googleapis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";
import nodemailer from "nodemailer";

const MIN_HOURS_BETWEEN_POSTS = 48;
const TIMEZONE = process.env.SCHEDULE_TIMEZONE || "America/Panama";
const STATE_PATH = new URL("./state.json", import.meta.url);
const ALERT_TO = process.env.ALERT_EMAIL_TO || "daniel@danielsimkin.com";

const REQUIRED_ENV = [
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "BROWSERBASE_CONTEXT_ID",
  "GOOGLE_SERVICE_ACCOUNT_KEY_B64",
  "DRIVE_FOLDER_ID",
  "SCHEDULE_SHEET_ID",
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required secret(s): ${missing.join(", ")}.`);
  }
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`[retry] ${label} failed (attempt ${i}/${attempts}): ${err.message}`);
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr.message}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(minMs, maxMs) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastPostTime: parsed.lastPostTime ?? null,
      lastIndex: typeof parsed.lastIndex === "number" ? parsed.lastIndex : -1,
      alertSent: parsed.alertSent ?? false,
      errorLog: Array.isArray(parsed.errorLog) ? parsed.errorLog : [],
    };
  } catch {
    console.warn("[state] state.json missing or invalid — starting fresh.");
    return { lastPostTime: null, lastIndex: -1, alertSent: false, errorLog: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function hoursSince(isoString, now) {
  if (!isoString) return Infinity;
  const then = new Date(isoString);
  if (Number.isNaN(then.getTime())) return Infinity;
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60);
}

async function sendAlertEmail(errorLog) {
  if (!process.env.ALERT_EMAIL_USER || !process.env.ALERT_EMAIL_APP_PASSWORD) {
    console.error("ALERT_EMAIL_USER/ALERT_EMAIL_APP_PASSWORD not set — cannot send alert email. Errors below:");
    console.error(errorLog.map((e) => `${e.time}: ${e.message}`).join("\n"));
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.ALERT_EMAIL_USER,
      pass: process.env.ALERT_EMAIL_APP_PASSWORD,
    },
  });

  const body = errorLog.map((e, i) => `${i + 1}. [${e.time}] ${e.message}`).join("\n\n");

  await transporter.sendMail({
    from: process.env.ALERT_EMAIL_USER,
    to: ALERT_TO,
    subject: "⚠️ Auto WhatsApp Status — needs attention",
    text: `The Auto WhatsApp Status automation is failing.\n\nYou will NOT receive another email until this is fixed and it succeeds again.\n\nErrors so far:\n\n${body}\n\nMost common cause: the WhatsApp linked-device session expired.\nFix: open WhatsApp on your phone, then re-run scripts/one-time-login.js.`,
  });
}

function googleAuth(scopes) {
  let creds;
  try {
    creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, "base64").toString("utf8"));
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_B64 is not valid base64 JSON.");
  }
  return new google.auth.GoogleAuth({ credentials: creds, scopes });
}

function nowInTimezone() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return new Date(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`);
}

async function checkScheduleAllowsPosting(now) {
  const auth = googleAuth(["https://www.googleapis.com/auth/spreadsheets.readonly"]);
  const sheets = google.sheets({ version: "v4", auth });

  const res = await withRetry("Read schedule sheet", () =>
    sheets.spreadsheets.values.get({ spreadsheetId: process.env.SCHEDULE_SHEET_ID, range: "Today!A1:B3" })
  );

  const rows = res.data.values || [];
  const workingRow = rows.find((r) => (r[0] || "").trim() === "Working?");
  const hoursRow = rows.find((r) => (r[0] || "").trim() === "Hours");

  const workingStatus = (workingRow?.[1] || "").trim().toLowerCase();
  const hours = (hoursRow?.[1] || "").trim();

  if (workingStatus === "no") return { allowed: false, reason: "Today is a non-working day" };
  if (workingStatus === "yes") return { allowed: true, reason: "Full working day" };
  if (workingStatus === "partially") {
    if (!hours || hours.toLowerCase() === "not working") {
      return { allowed: false, reason: "Marked Partially but no hours listed" };
    }
    const m = hours.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return { allowed: false, reason: `Unrecognized Hours format: "${hours}"` };
    const to24 = (h, mer) => {
      h = Number(h);
      if (mer.toUpperCase() === "PM" && h !== 12) h += 12;
      if (mer.toUpperCase() === "AM" && h === 12) h = 0;
      return h;
    };
    const start = new Date(now);
    start.setHours(to24(m[1], m[3]), Number(m[2]), 0, 0);
    const end = new Date(now);
    end.setHours(to24(m[4], m[6]), Number(m[5]), 0, 0);
    const within = now >= start && now <= end;
    return { allowed: within, reason: within ? "Within partial working window" : `Outside working window (${hours})` };
  }
  return { allowed: false, reason: `Unrecognized Working? value: "${workingRow?.[1]}"` };
}

async function listImages() {
  const auth = googleAuth(["https://www.googleapis.com/auth/drive.readonly"]);
  const drive = google.drive({ version: "v3", auth });
  const folderId = process.env.DRIVE_FOLDER_ID;

  const files = [];
  let pageToken;
  do {
    const res = await withRetry("List Drive images", () =>
      drive.files.list({
        q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
        fields: "nextPageToken, files(id, name)",
        pageToken,
        pageSize: 200,
      })
    );
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  if (files.length === 0) {
    throw new Error(`No images found in Drive folder ${folderId} — check it still has images and is shared with the service account.`);
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

function pickNext(images, state) {
  const nextIndex = ((state.lastIndex ?? -1) + 1) % images.length;
  return { image: images[nextIndex], nextIndex };
}

async function downloadImage(fileId, fileName) {
  const auth = googleAuth(["https://www.googleapis.com/auth/drive.readonly"]);
  const drive = google.drive({ version: "v3", auth });
  const res = await withRetry("Download image", () =>
    drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" })
  );
  const tmpPath = path.join(os.tmpdir(), fileName);
  await fs.writeFile(tmpPath, Buffer.from(res.data));
  return tmpPath;
}

async function postStatusImage(localImagePath) {
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });

  const session = await withRetry("Create Browserbase session", () =>
    bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      browserSettings: {
        context: { id: process.env.BROWSERBASE_CONTEXT_ID, persist: true },
        viewport: { width: 1280, height: 800 },
        timezoneId: "America/Panama",
      },
    })
  );

  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    await page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded" });
    await jitter(4000, 8000);

    const loggedIn = await page
      .locator('[aria-label="Chat list"], #pane-side')
      .first()
      .isVisible({ timeout: 20000 })
      .catch(() => false);

    if (!loggedIn) {
      throw new Error("WhatsApp Web is not logged in — the linked-device session likely expired. Open WhatsApp on your phone, then re-run scripts/one-time-login.js.");
    }

    await jitter(1500, 3500);

    const statusTab = page.locator('[aria-label="Status"]').first();
    await statusTab.waitFor({ state: "visible", timeout: 15000 });
    await statusTab.click();
    await jitter(1500, 3000);

    const addStatusButton = page.locator('[aria-label="Add Status"], [aria-label="My status"]').first();
    await addStatusButton.waitFor({ state: "visible", timeout: 15000 });
    await addStatusButton.click();
    await jitter(1000, 2500);

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 15000 });
    await fileInput.setInputFiles(localImagePath);
    await jitter(2500, 5000);

    const sendButton = page.locator('[aria-label="Send"]').first();
    await sendButton.waitFor({ state: "visible", timeout: 15000 });
    await sendButton.click();

    await jitter(4000, 7000);
  } catch (err) {
    try {
      const shot = path.join(os.tmpdir(), "failure-screenshot.png");
      await browser.contexts()[0]?.pages()[0]?.screenshot({ path: shot });
      console.error(`Saved failure screenshot to ${shot}`);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function run(state) {
  validateEnv();

  const now = nowInTimezone();

  const elapsed = hoursSince(state.lastPostTime, now);
  if (elapsed < MIN_HOURS_BETWEEN_POSTS) {
    console.log(`Only ${elapsed.toFixed(1)}h since last post (need ${MIN_HOURS_BETWEEN_POSTS}h). Skipping.`);
    return state;
  }

  const schedule = await checkScheduleAllowsPosting(now);
  console.log(`Schedule check: allowed=${schedule.allowed} (${schedule.reason})`);
  if (!schedule.allowed) return state;

  const images = await listImages();
  const { image, nextIndex } = pickNext(images, state);
  console.log(`Posting image: ${image.name} (index ${nextIndex} of ${images.length - 1})`);

  const localPath = await downloadImage(image.id, image.name);
  await postStatusImage(localPath);

  console.log("Posted successfully.");
  return { ...state, lastPostTime: now.toISOString(), lastIndex: nextIndex };
}

async function main() {
  const state = await loadState();

  try {
    const newState = await run(state);
    const cleared = { ...newState, alertSent: false, errorLog: [] };
    await saveState(cleared);
  } catch (err) {
    console.error("FAILED:", err.message);

    const errorLog = [...state.errorLog, { time: new Date().toISOString(), message: err.message }];

    if (!state.alertSent) {
      await sendAlertEmail(errorLog);
      await saveState({ ...state, alertSent: true, errorLog });
      console.log("Alert email sent. Further failures will stay silent until this resolves.");
    } else {
      await saveState({ ...state, errorLog });
      console.log("Already alerted for this failure streak — staying silent, logging error only.");
    }

    process.exitCode = 1;
  }
}

main();
