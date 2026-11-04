import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · Support Ops" };

type Params = Promise<{ error?: string }>;

// The form shell prerenders; reading ?error= is request data, so it streams in behind Suspense.
export default function LoginPage({ searchParams }: { searchParams: Params }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <Suspense fallback={<LoginForm />}>
        <WithError searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function WithError({ searchParams }: { searchParams: Params }) {
  const { error } = await searchParams;
  return <LoginForm error={error} />;
}
