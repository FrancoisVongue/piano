import { redirect } from 'next/navigation'

// Root URL just bounces to sign-in. Self-hosted Piano has no public-facing
// marketing page; if you're at "/", you're either signing in or already in.
export default function RootPage() {
  redirect('/signin')
}
