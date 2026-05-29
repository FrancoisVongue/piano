'use client'

import Link from 'next/link'
import { SignInForm } from '@/domain/auth/components/SignInForm'

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2">
            <div className="w-8 h-8 bg-black rounded flex items-center justify-center">
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="10" width="2" height="8" />
                <rect x="7" y="8" width="2" height="10" />
                <rect x="11" y="10" width="2" height="8" />
                <rect x="15" y="6" width="2" height="12" />
                <rect x="19" y="10" width="2" height="8" />
              </svg>
            </div>
            <span className="text-xl font-bold">Piano</span>
          </Link>
        </div>

        {/* Form Card */}
        <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">
              Welcome back
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Sign in to your account to continue
            </p>
          </div>
          
          <SignInForm />
          
          <div className="mt-6 text-center text-sm">
            <span className="text-gray-600">
              Don&apos;t have an account?{' '}
            </span>
            <Link
              href="/signup"
              className="font-medium text-green-600 hover:text-green-700"
            >
              Sign up
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}