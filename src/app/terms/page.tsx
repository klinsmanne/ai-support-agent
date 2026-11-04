import type { Metadata } from "next";
import { LegalPage } from "@/components/landing/LegalPage";

export const metadata: Metadata = { title: "Terms · Support Ops Agent" };

export default function Terms() {
  return (
    <LegalPage title="Terms of use" updated="November 4, 2026">
      <section>
        <h2>A demo, not a service</h2>
        <p>
          This site demonstrates an AI support agent for fictional companies. Nothing here is a real
          store: no order, refund or address change affects anything outside the demo database.
        </p>
      </section>
      <section>
        <h2>AI replies</h2>
        <p>
          Replies are written by AI and can be wrong. They are not professional, legal or financial
          advice.
        </p>
      </section>
      <section>
        <h2>Fair use</h2>
        <p>
          Please don&apos;t send real personal information, spam, or attempts to overload the
          service. Security testing such as prompt-injection attempts is welcome; it&apos;s part of
          what the demo shows. Rate limits apply.
        </p>
      </section>
      <section>
        <h2>No warranty</h2>
        <p>The demo is provided as is and may be changed, reset or taken offline at any time.</p>
      </section>
    </LegalPage>
  );
}
