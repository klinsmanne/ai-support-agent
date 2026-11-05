// Captures full-HD scenes of the live site for the demo video, with a caption bar burned in.
// Read-only: it only views pages and signs into the public read-only demo dashboard.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const SITE = "https://ai-support-ops-agent.vercel.app";
const OUT = new URL("./frames/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const scenes = JSON.parse(process.argv[2]);
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
const page = await ctx.newPage();

async function caption(text) {
  await page.evaluate((t) => {
    document.getElementById("__cap")?.remove();
    if (!t) return;
    const d = document.createElement("div");
    d.id = "__cap";
    d.textContent = t;
    Object.assign(d.style, {
      position: "fixed",
      left: "50%",
      bottom: "48px",
      transform: "translateX(-50%)",
      maxWidth: "1500px",
      padding: "18px 32px",
      borderRadius: "14px",
      background: "rgba(0,0,0,0.82)",
      color: "#fff",
      zIndex: "2147483647",
      font: "600 34px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      textAlign: "center",
      boxShadow: "0 8px 30px rgba(0,0,0,.45)",
    });
    document.body.appendChild(d);
  }, text);
}

async function signInDemo() {
  await page.goto(`${SITE}/login`, { waitUntil: "load" });
  await page.getByRole("button", { name: "View demo dashboard (read-only)" }).first().click();
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  await page.waitForTimeout(2500);
}

let signedIn = false;
for (const [i, s] of scenes.entries()) {
  if (s.html) {
    await page.setContent(s.html, { waitUntil: "load" });
  } else {
    if (s.demo && !signedIn) {
      await signInDemo();
      signedIn = true;
    }
    await page.goto(`${SITE}${s.path}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    if (s.scrollTo) {
      // Scroll so the element's top sits just below the header, even if it's already visible.
      await page.evaluate(
        ([text, offset]) => {
          const el = [...document.querySelectorAll("h1,h2,h3,h4,section,div,span,p")].find(
            (e) => e.children.length < 4 && e.textContent?.trim().startsWith(text),
          );
          if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY + offset);
        },
        [s.scrollTo, s.offset ?? -120],
      );
    }
    if (s.scrollY) await page.evaluate((y) => window.scrollTo(0, y), s.scrollY);
    await page.waitForTimeout(800);
  }
  await caption(s.caption);
  const file = `${OUT}${String(i).padStart(2, "0")}.png`;
  await page.screenshot({ path: file });
  console.log("captured", file);
}
await browser.close();
writeFileSync(`${OUT}done.txt`, "ok");
