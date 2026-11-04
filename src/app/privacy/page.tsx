import type { Metadata } from "next";
import { LegalPage } from "@/components/landing/LegalPage";

export const metadata: Metadata = { title: "Privacy policy · Support Ops Agent" };

export default function Privacy() {
  const contact = process.env.SUPPORT_EMAIL_ADDRESS ?? "the support inbox";
  return (
    <LegalPage title="Privacy policy" updated="November 4, 2026">
      <section>
        <h2>What this is</h2>
        <p>
          Support Ops Agent is a portfolio demonstration of an AI customer-support agent. The
          companies, customers and orders in it are fictional. Please don&apos;t send real personal,
          financial or health information.
        </p>
      </section>
      <section>
        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>Email:</strong> when you write to {contact}, we read your sender address and
            name, the subject, the message text and delivery headers (used to check the sender
            isn&apos;t forged).
          </li>
          <li>
            <strong>Chat:</strong> the messages you type and any order number and email you enter to
            verify. A one-way hash of your IP address is stored with the chat session, and your IP
            is used in short-lived counters, both only to prevent abuse.
          </li>
          <li>
            <strong>Dashboard sign-in:</strong> the email address of invited team members.
          </li>
        </ul>
        <p>We don&apos;t use advertising, analytics trackers or third-party cookies.</p>
      </section>
      <section>
        <h2>How it&apos;s used</h2>
        <p>
          Only to answer your message, to let a human reviewer take over when needed, and to measure
          how well the agent works (counts such as tickets handled). We never sell data or use it
          for advertising.
        </p>
      </section>
      <section>
        <h2>Who processes it</h2>
        <ul>
          <li>Google (Gmail API) to receive and send support email.</li>
          <li>
            Google (Gemini API) and Groq to generate replies. This demo uses free tiers; Google may
            use free-tier prompts to improve its products, which is another reason to send only
            fictional details.
          </li>
          <li>Supabase (database, in the United States) and Vercel (hosting).</li>
        </ul>
      </section>
      <section>
        <h2>Google user data</h2>
        <p>
          The Gmail connection is used only for the support inbox this app operates: to read
          incoming support email and send replies. To write a reply, the text of your email is sent
          to the AI providers listed above, including Gemini&apos;s free tier. Gmail data is not
          sold, not used for advertising, and not shared with anyone else.
        </p>
      </section>
      <section>
        <h2>Retention and deletion</h2>
        <p>
          Messages are kept for up to 90 days so the team can review them. Personal data is masked
          in internal logs. To have your messages deleted, email {contact} and we&apos;ll remove
          them.
        </p>
      </section>
      <section>
        <h2>Who can see it</h2>
        <p>
          Invited team members can see all tickets. The public read-only demo dashboard never shows
          emails from real senders; it shows only fictional demo data and anonymous chat
          conversations.
        </p>
      </section>
      <section>
        <h2>Contact</h2>
        <p>Questions or deletion requests: {contact}.</p>
      </section>
    </LegalPage>
  );
}
