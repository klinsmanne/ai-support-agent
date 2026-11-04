/**
 * Operator tool: moves recent customer mail that Gmail wrongly put in Spam back to the inbox,
 * so the next poll processes it. Lists what it moves (subject + sender domain only).
 * Usage: npm run email:unspam -- <messageId>   (or with no id: list recent spam)
 */
import "./load-env.ts";
import { buildContainer } from "../src/lib/server/build.ts";

const c = buildContainer(process.env);
if (!c.gmail) throw new Error("Gmail is not configured");
const id = process.argv[2];
if (!id) {
  console.log("Pass a message id to move it out of Spam.");
  process.exit(0);
}
await c.gmail.markNotSpam(id);
console.log(`✓ moved ${id} from Spam to Inbox`);
