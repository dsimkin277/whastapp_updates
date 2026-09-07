/**
 * RUN ONCE, LOCALLY.
 * Usage:
 *   npm install
 *   BROWSERBASE_API_KEY=xxx BROWSERBASE_PROJECT_ID=xxx npm run one-time-login
 */
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

async function main() {
  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    throw new Error("Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID before running this.");
  }

  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });

  const context = await bb.contexts.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  console.log(`\nCreated Browserbase Context: ${context.id}`);
  console.log("Save this as the BROWSERBASE_CONTEXT_ID secret in GitHub.\n");

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    browserSettings: { context: { id: context.id, persist: true }, viewport: { width: 1280, height: 800 } },
  });

  console.log(`Open this live session URL in your browser and watch for the QR code:`);
  console.log(session.connectUrl.replace("wss://", "https://").replace("connect", "live") || session.connectUrl);
  console.log("(If that link doesn't work, open your Browserbase dashboard > Sessions > this session > Live View.)\n");

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto("https://web.whatsapp.com", { waitUntil: "domcontentloaded" });

  console.log("Scan the QR code with WhatsApp on your phone: Settings > Linked Devices > Link a Device.");
  console.log("Checking every 5s for up to 3 minutes...\n");

  let loggedIn = false;
  for (let i = 0; i < 36; i++) {
    loggedIn = await page.locator('[aria-label="Chat list"], #pane-side').first().isVisible().catch(() => false);
    if (loggedIn) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log(loggedIn ? "✅ Logged in. Context saved — this is reusable from now on." : "⚠️ Didn't detect login in 3 min. Re-run and check the live view URL above.");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
