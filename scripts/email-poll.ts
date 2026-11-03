/**
 * Runs one Gmail polling cycle locally with the production wiring (real inbox, real database,
 * real models). Usage: npm run email:poll
 */
import "./load-env.ts";
import { pollGmail } from "../src/lib/channels/email/poll.ts";
import { buildContainer } from "../src/lib/server/build.ts";

const c = buildContainer(process.env);
if (!c.gmail) throw new Error("Gmail is not configured (npm run gmail:auth)");
const report = await pollGmail(c.gmail, c.deps, await c.defaultTenantId());
console.log(JSON.stringify(report, null, 2));
